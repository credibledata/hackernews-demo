// Build the curated Hacker News Parquet slice the Malloy model reads.
//
// Reads the open-index/hacker-news dataset (Parquet on Hugging Face: one file
// per month under data/, plus 5-minute live blocks for today under today/) for a
// configurable lookback window, splits it into `stories` and `comments`, derives
// a few fields that are expensive to compute at query time (domain, category,
// and each comment's root story id), and writes two local Parquet files.
//
// Config (env, read by the CLI at the bottom):
//   HN_MONTHS  how many months back from HN_END          (default 36)
//   HN_END     last month to include, "YYYY-MM"          (default: latest available)
//   HN_TYPES   item types to keep, comma-separated        (default 1,2,5)
//   HN_OUT     output directory                           (default ./package/data)
//   HN_REFRESH_SCORES        set to 0 to skip the live score refresh (default on)
//   HN_REFRESH_SCORES_DAYS   how far back the refresh reaches (default 90)
//   HN_REFRESH_CONCURRENCY   in-flight HN API requests     (default 50)
//   HN_SCRATCH               working dir for the DuckDB build database
//   HN_DUCKDB_MEMORY         DuckDB memory_limit, e.g. "4GB" (default: DuckDB's own)
//
// The score refresh matters: the upstream dataset freezes `score` and
// `descendants` at ingest, so without it every score-based aggregate measures
// the first minutes after posting rather than the story's actual reception.
// It reaches back HN_REFRESH_SCORES_DAYS, not over the whole window — see
// DEFAULT_SCORE_REFRESH_DAYS.
//
// The ETL (`buildData`) takes an explicit list of source files, so it runs the
// same whether the source is Hugging Face or a local fixture — which is what the
// tests use.

import { DuckDBInstance, quotedString } from '@duckdb/node-api';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HF_REPO = 'hf://datasets/open-index/hacker-news';
const HF_MONTHLY_GLOB = `${HF_REPO}/data/*/*.parquet`;
// Upstream commits new items as 5-minute blocks under today/ and only folds them
// into the month's Parquet at midnight UTC, so the monthly files on their own
// are up to a day behind and never carry today at all. Path shape is
// today/YYYY/MM/DD/HH/MM.parquet.
const HF_LIVE_GLOB = `${HF_REPO}/today/*/*/*/*/*.parquet`;
const MONTH_RE = /(\d{4})-(\d{2})\.parquet$/;
const LIVE_MONTH_RE = /\/today\/(\d{4})\/(\d{2})\//;

// How far back the live score refresh reaches. A story settles within weeks;
// past that a re-read costs a request and changes nothing. Over a three-year
// window, refreshing everything would be ~1.07M requests per run — enough to
// get rate-limited, and a 5% failure rate fails the build.
export const DEFAULT_SCORE_REFRESH_DAYS = 90;

// Three years: ~11.4M items, ~217MB of Parquet out, about 10 minutes and a
// 3.2GB peak to build. The full archive goes back to 2006-10 and is ~49M items
// — 4x this, which neither the image nor the refresh would take kindly to.
export const DEFAULT_MONTHS = 36;

/**
 * Open a DuckDB connection with httpfs loaded (needed for hf:// reads).
 *
 * Defaults to an in-memory database, which is what the tests want. Pass
 * `dbPath` for a real build: an in-memory database cannot evict table data, so
 * the whole working set — `items` is ~11M rows over a three-year window — has
 * to stay resident. Backed by a file, DuckDB writes blocks out under pressure;
 * the measured three-year build peaks at 3.2GB rather than growing with the
 * table.
 *
 * `memoryLimit` is a hard cap, not a hint. Set it below what the build needs
 * and DuckDB fails with "failed to allocate data" instead of spilling further,
 * so it is opt-in (HN_DUCKDB_MEMORY) and unset by default — DuckDB sizes
 * itself to the host.
 */
export async function openConnection({ dbPath, memoryLimit, tempDir } = {}) {
  const instance = await DuckDBInstance.create(dbPath || ':memory:');
  const con = await instance.connect();
  await con.run('INSTALL httpfs; LOAD httpfs;');
  if (tempDir) await con.run(`SET temp_directory = ${quotedString(tempDir)};`);
  if (memoryLimit) await con.run(`SET memory_limit = ${quotedString(memoryLimit)};`);
  // Pinned so the ETL means the same thing on a laptop as in the container:
  // otherwise any timestamp comparison here would silently follow the host's
  // local zone. This matches how Malloy's DuckDB connection runs.
  await con.run("SET TimeZone = 'UTC';");
  return con;
}

// The zone hn.malloy reports in. The source files are partitioned by UTC month,
// so the two disagree at the window's edges — see the trim in buildData.
const MODEL_TZ = 'America/Los_Angeles';

const monthIndex = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return y * 12 + (mo - 1);
};

/** The calendar month ("YYYY-MM") a source file belongs to, or null. */
function monthOf(file) {
  const monthly = file.match(MONTH_RE);
  if (monthly) return `${monthly[1]}-${monthly[2]}`;
  const live = file.match(LIVE_MONTH_RE);
  return live ? `${live[1]}-${live[2]}` : null;
}

const byMonth = (files) =>
  files
    .map((file) => ({ file, month: monthOf(file) }))
    .filter((x) => x.month)
    .sort((a, b) => a.month.localeCompare(b.month) || a.file.localeCompare(b.file));

/**
 * Pick the source files inside the lookback window: the monthly Parquet files,
 * plus the live blocks for the window's final month.
 *
 * Only the final month, because that is the only month a live block can add
 * anything to. Upstream is supposed to clear a day's blocks once it has folded
 * them into that month's Parquet, but it does not always manage it — the repo
 * currently still carries blocks from April, May and June, months consolidated
 * long ago — and every one of those is a row we already have.
 *
 * The same cut drops them whenever the window ends before today: HN_END pinning
 * it to a past month, or the first of a month before upstream has written the
 * new month's Parquet, where taking the blocks would grow a trailing bucket
 * holding a few hours against full months either side of it.
 */
export function selectSourceFiles(monthlyFiles, liveFiles, { months = DEFAULT_MONTHS, end } = {}) {
  const available = byMonth(monthlyFiles);
  if (available.length === 0) {
    throw new Error(`No dataset files found at ${HF_MONTHLY_GLOB}`);
  }
  const endMonth = end || available[available.length - 1].month;
  const endIdx = monthIndex(endMonth);
  const startIdx = endIdx - (months - 1);
  const inWindow = (month) => monthIndex(month) >= startIdx && monthIndex(month) <= endIdx;

  const picked = available.filter((x) => inWindow(x.month));
  if (picked.length === 0) {
    throw new Error(`No files in window ${months}mo ending ${endMonth}`);
  }
  const live = byMonth(liveFiles).filter((x) => x.month === endMonth);

  // `files` is the flat list; `monthly` and `todayFiles` are the same files
  // split by source, which the build needs kept apart to rank duplicates and to
  // convert today/'s naive timestamps.
  return {
    files: [...picked.map((x) => x.file), ...live.map((x) => x.file)],
    monthly: picked.map((x) => x.file),
    todayFiles: live.map((x) => x.file),
    liveFiles: live.length,
    endMonth,
    startMonth: picked[0].month,
  };
}

const globFiles = async (con, pattern) =>
  (await con.runAndReadAll(`SELECT file FROM glob(${quotedString(pattern)}) ORDER BY file`))
    .getRows()
    .map((row) => String(row[0]));

/**
 * List the Hugging Face files that fall inside the lookback window. Globs the
 * dataset (a metadata call, not a data download), so a month that doesn't exist
 * yet is simply absent rather than a hard error.
 */
export async function resolveSourceFiles(con, { months = DEFAULT_MONTHS, end } = {}) {
  const [monthlyFiles, liveFiles] = await Promise.all([
    globFiles(con, HF_MONTHLY_GLOB),
    // today/ is empty for a moment after each midnight roll, and absent
    // entirely on a mirror that doesn't publish live blocks. Neither is a
    // reason to fail the build — but say so, since it costs freshness.
    globFiles(con, HF_LIVE_GLOB).catch((e) => {
      console.warn(`[prep] no live blocks (${e?.message || e}) — monthly files only`);
      return [];
    }),
  ]);
  return selectSourceFiles(monthlyFiles, liveFiles, { months, end });
}

/** Build a `read_parquet([...])` expression from a list of file paths/urls. */
const readParquetExpr = (files) =>
  `read_parquet([${files.map(quotedString).join(', ')}], union_by_name = true)`;

const HN_ITEM_URL = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-read `score` and `descendants` from the HN API and write the current
 * values back into `items`.
 *
 * The upstream dataset snapshots both fields at (or shortly after) ingest and
 * never refreshes them, so they measure the first few minutes of a story's life
 * rather than its eventual reception — badly enough to invert any ranking built
 * on them. One well-discussed story in a recent slice carried score 368 /
 * descendants 231 against live values of 1561 / 1113.
 *
 * Only stories and jobs (type 1 and 5) are fetched; comments carry neither
 * field. Items the API no longer knows about (deleted since ingest) keep their
 * original values — a stale number beats an invented one.
 *
 * `sinceDays` limits the refresh to items that young. A story's score settles
 * within weeks, so older rows keep the upstream snapshot — which is what it
 * already was, at a fraction of the requests. Omit it to refresh everything.
 */
export async function refreshLiveScores(
  con,
  {
    fetchImpl = fetch,
    concurrency = Number(process.env.HN_REFRESH_CONCURRENCY || 50),
    retries = 3,
    retryDelayMs = 250,
    maxFailureRate = 0.05,
    sinceDays = null,
    onProgress,
  } = {}
) {
  if (sinceDays != null && !(Number.isFinite(sinceDays) && sinceDays > 0)) {
    throw new Error(`refreshLiveScores: sinceDays must be a positive number, got ${sinceDays}`);
  }
  const cutoff = sinceDays == null ? '' : `AND time >= now() - INTERVAL ${Number(sinceDays)} DAY`;
  const ids = (
    await con.runAndReadAll(`SELECT id FROM items WHERE type IN (1, 5) ${cutoff} ORDER BY id`)
  )
    .getRows()
    .map((r) => Number(r[0]));
  const sinceDaysOut = sinceDays ?? null;
  if (ids.length === 0) {
    return { fetched: 0, updated: 0, missing: 0, failed: 0, sinceDays: sinceDaysOut };
  }

  const live = [];
  let missing = 0;
  let failed = 0;
  let done = 0;
  let cursor = 0;

  // A fixed pool of workers pulling from one cursor: keeps exactly `concurrency`
  // requests in flight without materialising 80k promises up front.
  const worker = async () => {
    for (let i = cursor++; i < ids.length; i = cursor++) {
      const id = ids[i];
      let item;
      let ok = false;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetchImpl(HN_ITEM_URL(id));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          item = await res.json();
          ok = true;
          break;
        } catch {
          if (attempt < retries) await sleep(retryDelayMs * 2 ** attempt);
        }
      }
      if (!ok) failed++;
      else if (!item) missing++;
      else live.push([id, item.score, item.descendants]);
      if (onProgress && ++done % 5000 === 0) onProgress(done, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));

  // Publishing a slice that is mostly stale is worse than not publishing: the
  // numbers would still look authoritative. Fail the build instead.
  if (failed / ids.length > maxFailureRate) {
    throw new Error(
      `live score refresh failed for ${failed}/${ids.length} items ` +
        `(over the ${(maxFailureRate * 100).toFixed(0)}% tolerance) — refusing to write partly-stale data`
    );
  }

  await con.run(`CREATE OR REPLACE TEMP TABLE live_scores (id BIGINT, score INTEGER, descendants INTEGER);`);
  const num = (v) => (Number.isFinite(v) ? v : 'NULL');
  for (let i = 0; i < live.length; i += 1000) {
    const values = live
      .slice(i, i + 1000)
      .map(([id, s, d]) => `(${id}, ${num(s)}, ${num(d)})`)
      .join(', ');
    await con.run(`INSERT INTO live_scores VALUES ${values};`);
  }
  // coalesce, not straight assignment: a story the API returns without a score
  // should keep the one we already had rather than go null.
  await con.run(`
    UPDATE items SET
      score       = coalesce(l.score, items.score),
      descendants = coalesce(l.descendants, items.descendants)
    FROM live_scores l
    WHERE items.id = l.id;
  `);

  return { fetched: ids.length, updated: live.length, missing, failed, sinceDays: sinceDaysOut };
}

/**
 * Split, clean, and enrich the source files into stories.parquet and
 * comments.parquet under `outDir`. Returns row counts and the share of comments
 * whose root story resolved (comments rooted before the window resolve to null).
 *
 * `sourceFiles` are the monthly files; `todayFiles` are the today/ files
 * covering the gap since the last monthly commit, and may overlap them.
 *
 * `refreshScores` opts into the live HN score/comment refresh described above.
 * It defaults off so the ETL — and its tests — stay hermetic; the CLI turns it
 * on.
 */
export async function buildData(
  con,
  {
    sourceFiles,
    todayFiles = [],
    outDir,
    types = [1, 2, 5],
    refreshScores = false,
    refreshScoreDays = DEFAULT_SCORE_REFRESH_DAYS,
    startMonth,
    fetchImpl,
    onProgress,
  } = {}
) {
  if (!sourceFiles?.length) throw new Error('buildData: sourceFiles is required');
  if (startMonth !== undefined && !/^\d{4}-\d{2}$/.test(startMonth)) {
    throw new Error(`buildData: startMonth must be "YYYY-MM", got ${JSON.stringify(startMonth)}`);
  }
  await mkdir(outDir, { recursive: true });
  const storiesPath = path.join(outDir, 'stories.parquet');
  const commentsPath = path.join(outDir, 'comments.parquet');
  const typeList = types.join(', ');

  // The first hours of the window's first UTC day are still the previous month
  // in the zone the model reports in, so they would land in a leading bucket
  // holding a fraction of a day — 142 stories against June's 18,323 in the
  // 2012-06 slice. Drop them, and the monthly views start on a whole month.
  // The window's tail is short by the same offset for the opposite reason; that
  // costs the final month under 1% and is left alone rather than pulling down
  // another month of source data to square it off.
  // The trim compares against the converted instant, so it means the same thing
  // for both sources.
  const trimFor = (timeExpr) =>
    startMonth
      ? `AND ${timeExpr} >= timezone('${MODEL_TZ}', TIMESTAMP '${startMonth}-01 00:00:00')`
      : '';

  // One projection, two sources. today/ stores `time` as a naive TIMESTAMP
  // where the monthly files store an instant. openConnection pins the session
  // zone to UTC, so a bare union_by_name read resolves it correctly today —
  // but only because of that SET three functions away. Converting explicitly
  // keeps the correctness local to the query: read under any other session
  // zone, an unconverted naive value silently shifts by the offset.
  const select = (files, rank, timeExpr) => `
    SELECT
      ${rank}       AS source_rank,
      id,
      type,
      "by"          AS author,
      ${timeExpr}   AS time,
      parent,
      url,
      score,
      title,
      descendants,
      length(text)  AS text_len
    FROM ${readParquetExpr(files)}
    WHERE coalesce(deleted, 0) = 0
      AND coalesce(dead, 0) = 0
      AND type IN (${typeList})
      ${trimFor(timeExpr)}
  `;

  const sources = [select(sourceFiles, 0, 'time')];
  if (todayFiles.length) sources.push(select(todayFiles, 1, `timezone('UTC', time)`));

  // One working table: live items in the window, heavy columns dropped.
  //
  // The window can name the same item twice — a live block upstream had not yet
  // cleared when it refetched that month's Parquet, or one committed between
  // this build's two globs. The rows are copies of one item, so exactly one has
  // to survive: a duplicate would inflate every count and average in the model.
  // `source_rank` decides which, rather than leaving it to whichever row the
  // scan happens to reach first — the monthly row is the committed one, so a
  // rebuild from the same window is reproducible.
  await con.run(`
    CREATE OR REPLACE TABLE items AS
    WITH raw AS (${sources.join('\n    UNION ALL\n')})
    SELECT * FROM raw
    QUALIFY row_number() OVER (PARTITION BY id ORDER BY source_rank) = 1;
  `);

  // Before anything is written: replace the ingest-time score/comment snapshots
  // with current values, so every downstream aggregate measures reception
  // rather than the first few minutes after posting.
  const refreshed = refreshScores
    ? await refreshLiveScores(con, { fetchImpl, onProgress, sinceDays: refreshScoreDays })
    : null;

  // Stories (and jobs): derive domain and a human category.
  await con.run(`
    COPY (
      SELECT
        id,
        author AS "by",
        time,
        score,
        descendants,
        title,
        url,
        nullif(regexp_extract(lower(coalesce(url, '')), '://(?:www\\.)?([^/]+)', 1), '') AS domain,
        CASE
          WHEN type = 5                THEN 'Job'
          WHEN title ILIKE 'Ask HN:%'  THEN 'Ask HN'
          WHEN title ILIKE 'Show HN:%' THEN 'Show HN'
          ELSE 'Link'
        END AS category
      FROM items
      WHERE type IN (1, 5)
      ORDER BY id
    ) TO ${quotedString(storiesPath)} (FORMAT parquet, COMPRESSION zstd);
  `);

  // Resolve each comment's root story by climbing the parent chain. A comment
  // whose ancestor story is outside the window drops out of the join and gets a
  // null root_story_id downstream.
  await con.run(`
    CREATE OR REPLACE TABLE root_map AS
    WITH RECURSIVE walk(comment_id, cur, depth) AS (
      SELECT id, parent, 1 FROM items WHERE type = 2
      UNION ALL
      SELECT w.comment_id, i.parent, w.depth + 1
      FROM walk w JOIN items i ON w.cur = i.id
      WHERE i.type = 2 AND w.depth < 50
    )
    SELECT comment_id, cur AS root_story_id
    FROM walk w
    JOIN items i ON w.cur = i.id
    WHERE i.type IN (1, 5)
    QUALIFY row_number() OVER (PARTITION BY comment_id ORDER BY depth) = 1;
  `);

  await con.run(`
    COPY (
      SELECT
        i.id,
        i.author AS "by",
        i.time,
        i.parent,
        rm.root_story_id,
        i.text_len AS length
      FROM items i
      LEFT JOIN root_map rm ON i.id = rm.comment_id
      WHERE i.type = 2
      ORDER BY i.id
    ) TO ${quotedString(commentsPath)} (FORMAT parquet, COMPRESSION zstd);
  `);

  const stats = (
    await con.runAndReadAll(`
      SELECT
        (SELECT count(*) FROM items WHERE type IN (1,5))                                    AS stories,
        (SELECT count(*) FROM items WHERE type = 2)                                         AS comments,
        (SELECT count(*) FROM root_map)                                                     AS resolved,
        (SELECT count(*) FROM items WHERE source_rank = 1)                                  AS from_today
    `)
  ).getRowObjects()[0];

  const stories = Number(stats.stories);
  const comments = Number(stats.comments);
  const resolved = Number(stats.resolved);
  return {
    stories,
    comments,
    resolved,
    resolutionRate: comments === 0 ? 1 : resolved / comments,
    fromToday: Number(stats.from_today),
    refreshed,
    storiesPath,
    commentsPath,
  };
}

/** ETL settings from the environment. Shared so the CLI and the scheduled
 *  refresh cannot drift apart on defaults. */
export function envConfig() {
  return {
    months: Number(process.env.HN_MONTHS || DEFAULT_MONTHS),
    end: process.env.HN_END || undefined,
    types: (process.env.HN_TYPES || '1,2,5').split(',').map((t) => Number(t.trim())),
    refreshScores: process.env.HN_REFRESH_SCORES !== '0',
    refreshScoreDays: Number(process.env.HN_REFRESH_SCORES_DAYS || DEFAULT_SCORE_REFRESH_DAYS),
  };
}

/**
 * A connection for a real build: disk-backed, so a multi-year window's working
 * set spills instead of sitting in RAM. Returns the connection and a cleanup
 * that removes the scratch database.
 */
export async function openBuildConnection() {
  const scratchDir = process.env.HN_SCRATCH || path.join(tmpdir(), 'hn-etl');
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(scratchDir, { recursive: true });
  const con = await openConnection({
    dbPath: path.join(scratchDir, 'etl.duckdb'),
    tempDir: scratchDir,
    memoryLimit: process.env.HN_DUCKDB_MEMORY || undefined,
  });
  return { con, cleanup: () => rm(scratchDir, { recursive: true, force: true }) };
}

/** The `.metadata.json` the app reads to describe the slice it is serving. */
export const metadataFor = ({ startMonth, endMonth, months, stats }) =>
  JSON.stringify({
    refreshedAt: new Date().toISOString(),
    scoresRefreshed: Boolean(stats.refreshed),
    scoreRefreshDays: stats.refreshed?.sinceDays ?? null,
    windowMonths: months,
    startMonth,
    endMonth,
    fromToday: stats.fromToday,
  }) + '\n';

// ── CLI ────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { months, end, types, refreshScores, refreshScoreDays } = envConfig();
  const outDir = process.env.HN_OUT || path.resolve('package/data');

  const { con, cleanup } = await openBuildConnection();
  console.log(`[prep] resolving window: ${months} month(s)${end ? ` ending ${end}` : ' ending latest'}`);
  const { monthly, todayFiles, startMonth, endMonth } = await resolveSourceFiles(con, { months, end });
  console.log(
    `[prep] window ${startMonth}..${endMonth} — ${monthly.length} monthly file(s)` +
      ` + ${todayFiles.length} live block(s) for today`
  );
  console.log('[prep] building (downloads + ETL; this can take a while on wide windows)…');
  const t0 = Date.now();
  if (refreshScores) {
    console.log(`[prep] will refresh scores/comment counts from the HN API (last ${refreshScoreDays} days)`);
  }
  const stats = await buildData(con, {
    sourceFiles: monthly,
    todayFiles,
    outDir,
    types,
    refreshScores,
    refreshScoreDays,
    startMonth,
    onProgress: (done, total) => console.log(`[prep]   live refresh ${done}/${total}`),
  });
  await cleanup();
  // Marker the container entrypoint reads to decide whether to re-fetch on boot.
  await writeFile(path.join(outDir, '.window'), `${months}:${end || 'latest'}\n`);
  await writeFile(
    path.join(outDir, '.metadata.json'),
    metadataFor({ startMonth, endMonth, months, stats })
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[prep] done in ${secs}s → ${outDir}\n` +
      `[prep]   stories:  ${stats.stories.toLocaleString()}\n` +
      `[prep]   comments: ${stats.comments.toLocaleString()} ` +
      `(root story resolved: ${(stats.resolutionRate * 100).toFixed(1)}%)` +
      (stats.fromToday ? `\n[prep]   from today/: ${stats.fromToday.toLocaleString()} item(s) not yet in a monthly file` : '') +
      (stats.refreshed
        ? `\n[prep]   live scores: ${stats.refreshed.updated.toLocaleString()} refreshed` +
          `${stats.refreshed.sinceDays ? ` (last ${stats.refreshed.sinceDays} days; older keep upstream values)` : ''}, ` +
          `${stats.refreshed.missing.toLocaleString()} gone from the API, ${stats.refreshed.failed} failed`
        : '\n[prep]   live scores: skipped (HN_REFRESH_SCORES=0) — scores are ingest-time snapshots')
  );
  if (stats.comments > 0 && stats.resolutionRate < 0.5) {
    console.warn(
      `[prep] WARNING: low root-story resolution (${(stats.resolutionRate * 100).toFixed(1)}%). ` +
        `Many comments reference stories older than the window — widen HN_MONTHS for denser joins.`
    );
  }
}
