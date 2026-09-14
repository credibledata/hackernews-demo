// Refresh the served data in place, without a restart and without users
// noticing. Strategy:
//
//   1. Build a fresh slice into a NEW versioned directory (data.vN+1). The
//      heavy download + ETL never touches the live files, so serving is
//      unaffected while it runs.
//   2. Validate the new build (both parquet files present, non-empty).
//   3. Atomically swap the `package/data` symlink to the new version. A rename
//      over a symlink is atomic, so both parquet files flip as one unit — no
//      query ever sees new-stories + old-comments.
//   4. Ask Publisher to reload the package from disk (GET ...?reload=true), so
//      it re-opens the new files. In-flight queries keep their old file handles
//      and finish consistently against the old data.
//
// Requires the symlink layout (`package/data` -> `data.vN`); the container
// entrypoint normalizes to it at boot.
//
// The entrypoint runs this once at boot and then every HN_REFRESH_INTERVAL, so
// that a container which never lives a full interval — a restart loop, or a host
// that stops it between requests — still refreshes. A run whose data is younger
// than the interval exits without building; `--force` overrides that.

import { readlink, symlink, rename, rm, readdir, writeFile, stat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openConnection, resolveSourceFiles, buildData } from './build-data.mjs';

const PACKAGE_DIR = path.resolve(process.env.HN_PACKAGE_DIR || 'package');
const DATA_LINK = path.join(PACKAGE_DIR, 'data');
const LOCK_DIR = path.join(PACKAGE_DIR, '.refresh.lock');
const LOCK_STALE_MS = 60 * 60 * 1000; // a build well under an hour; older = crashed run
// Also how old data has to be before a run rebuilds it: the period the container
// refreshes on and "old enough to be worth rebuilding" are the same number.
const INTERVAL_MS = Number(process.env.HN_REFRESH_INTERVAL || 86400) * 1000;

const restUrl = process.env.PUBLISHER_REST_URL || 'http://127.0.0.1:4000/api/v0';
const envName = process.env.HN_ENV || 'hn';
const pkgName = process.env.HN_PACKAGE || 'hacker-news';

const log = (msg) => console.log(`[refresh] ${msg}`);

/** Current symlink target (e.g. "data.v3") and its version number. */
async function currentVersion() {
  const target = await readlink(DATA_LINK); // throws if not a symlink — see entrypoint normalization
  const n = Number((target.match(/\.v(\d+)$/) || [])[1]);
  if (!Number.isInteger(n)) throw new Error(`unexpected data symlink target: ${target}`);
  return { target, n };
}

/** Atomically repoint the `data` symlink to `dirName` (relative, e.g. "data.v4"). */
async function swapLink(dirName) {
  const tmp = `${DATA_LINK}.tmp.${process.pid}`;
  await symlink(dirName, tmp); // relative target: resolves inside the package dir
  await rename(tmp, DATA_LINK); // atomic replace of the existing symlink
}

/** Keep the current and immediately-previous versions; remove older ones. */
async function pruneOld(keepFrom) {
  const entries = await readdir(PACKAGE_DIR);
  for (const name of entries) {
    const m = name.match(/^data\.v(\d+)$/);
    if (m && Number(m[1]) < keepFrom) {
      await rm(path.join(PACKAGE_DIR, name), { recursive: true, force: true });
      log(`pruned ${name}`);
    }
  }
}

async function reloadPublisher() {
  const url = `${restUrl}/environments/${envName}/packages/${encodeURIComponent(pkgName)}?reload=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Publisher reload failed (${res.status})`);
  log('Publisher reloaded');
}

/** Acquire an exclusive lock (mkdir is atomic); take over a stale one from a crash. */
async function acquireLock() {
  try {
    await mkdir(LOCK_DIR);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = Date.now() - (await stat(LOCK_DIR)).mtimeMs;
    if (age < LOCK_STALE_MS) throw new Error('another refresh is in progress (lock held)');
    log('taking over a stale refresh lock');
  }
}

/**
 * Whether the served data is old enough to be worth rebuilding.
 *
 * The container refreshes at boot as well as on the interval, so the decision
 * has to live here: without it a container restarting more often than the
 * interval would rebuild the whole slice — and re-read every score from the HN
 * API — on every restart. Data whose age can't be established is treated as due,
 * since the alternative is serving unknown-age data forever.
 */
export function isDue(metadata, { now = Date.now(), minAgeMs = INTERVAL_MS } = {}) {
  const refreshedAt = Date.parse(metadata?.refreshedAt ?? '');
  if (!Number.isFinite(refreshedAt)) return true;
  const age = now - refreshedAt;
  return age < 0 || age >= minAgeMs; // a future timestamp is clock skew, not freshness
}

/** The current data's build metadata, or {} if it has none we can read. */
async function currentMetadata() {
  try {
    return JSON.parse(await readFile(path.join(DATA_LINK, '.metadata.json'), 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error(`[refresh] metadata: ${e?.message || e}`);
    return {};
  }
}

export async function refresh({ force = false, minAgeMs = INTERVAL_MS } = {}) {
  if (!force && !isDue(await currentMetadata(), { minAgeMs })) {
    log(`data is newer than ${(minAgeMs / 3600000).toFixed(1)}h — nothing to do`);
    return { skipped: true };
  }
  await acquireLock();
  try {
    await runRefresh();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
  return { skipped: false };
}

async function runRefresh() {
  const { n } = await currentVersion();
  const nextName = `data.v${n + 1}`;
  const outDir = path.join(PACKAGE_DIR, nextName);

  const months = Number(process.env.HN_MONTHS || 12);
  const end = process.env.HN_END || undefined;
  const types = (process.env.HN_TYPES || '1,2,5').split(',').map((t) => Number(t.trim()));

  const con = await openConnection();
  const { files, startMonth, endMonth } = await resolveSourceFiles(con, { months, end });
  log(`building ${startMonth}..${endMonth} (${files.length} file(s)) -> ${nextName}`);
  const stats = await buildData(con, {
    sourceFiles: files,
    outDir,
    types,
    refreshScores: process.env.HN_REFRESH_SCORES !== '0',
  });

  // Validate before we touch anything live.
  if (!(stats.stories > 0)) throw new Error('new build has zero stories — not swapping');
  for (const f of ['stories.parquet', 'comments.parquet']) {
    const s = await stat(path.join(outDir, f));
    if (!s.size) throw new Error(`new build has empty ${f} — not swapping`);
  }

  // Markers travel with the version dir, so they follow the symlink.
  await writeFile(path.join(outDir, '.window'), `${months}:${end || 'latest'}\n`);
  await writeFile(path.join(outDir, '.version'), `${n + 1}\n`);
  await writeFile(
    path.join(outDir, '.metadata.json'),
    JSON.stringify({
      refreshedAt: new Date().toISOString(),
      scoresRefreshed: process.env.HN_REFRESH_SCORES !== '0',
      startMonth,
      endMonth,
    }) + '\n'
  );

  await swapLink(nextName);
  log(`swapped data -> ${nextName} (${stats.stories.toLocaleString()} stories, ${stats.comments.toLocaleString()} comments)`);

  // The swap is committed and the new data is valid on disk. A reload failure is
  // not fatal — Publisher serves the new data on its next reload/cycle — so log
  // it and still prune old versions.
  try {
    await reloadPublisher();
  } catch (e) {
    console.error(`[refresh] data swapped, but Publisher reload failed: ${e?.message || e}. New data loads on the next reload.`);
  }
  await pruneOld(n); // keep vN (previous) and vN+1 (current)
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  refresh({ force: process.argv.includes('--force') })
    .then(({ skipped }) => log(skipped ? 'skipped' : 'done'))
    .catch((e) => {
      console.error(`[refresh] FAILED (current data left in place): ${e?.message || e}`);
      process.exit(1);
    });
}
