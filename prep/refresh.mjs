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
// entrypoint normalizes to it at boot. Run on a schedule (see entrypoint.sh).

import { readlink, symlink, rename, rm, readdir, writeFile, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openConnection, resolveSourceFiles, buildData } from './build-data.mjs';

const PACKAGE_DIR = path.resolve(process.env.HN_PACKAGE_DIR || 'package');
const DATA_LINK = path.join(PACKAGE_DIR, 'data');
const LOCK_DIR = path.join(PACKAGE_DIR, '.refresh.lock');
const LOCK_STALE_MS = 60 * 60 * 1000; // a build well under an hour; older = crashed run

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

export async function refresh() {
  await acquireLock();
  try {
    await runRefresh();
  } finally {
    await rm(LOCK_DIR, { recursive: true, force: true });
  }
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
  refresh()
    .then(() => log('done'))
    .catch((e) => {
      console.error(`[refresh] FAILED (current data left in place): ${e?.message || e}`);
      process.exit(1);
    });
}
