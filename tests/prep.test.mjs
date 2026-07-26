// Hermetic test for the prep ETL: build a fixture Parquet with known parent
// chains, run buildData against it, and assert the split, the derived fields,
// and the exact root-story resolution — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { quotedString } from '@duckdb/node-api';
import { openConnection, buildData, refreshLiveScores } from '../prep/build-data.mjs';

// One row per HN item. Columns mirror the real dataset (subset we use).
// Chains:  10->1, 11->10->1, 12->2   ; 13->999 (outside) ; deleted/dead excluded.
const FIXTURE_ROWS = `
  VALUES
  -- id, deleted, type, by,        time,                       text,          dead, parent, url,                          score, title,          descendants
    (1,  0, 1, 'alice', TIMESTAMP '2024-01-01 08:00:00', NULL,           0, NULL, NULL,                          120, 'Ask HN: how?',  2),
    (2,  0, 1, 'bob',   TIMESTAMP '2024-01-01 09:30:00', NULL,           0, NULL, 'https://www.example.com/post', 300, 'Show HN: cool', 1),
    (3,  0, 5, 'hr',    TIMESTAMP '2024-01-02 12:00:00', NULL,           0, NULL, 'https://jobs.example.org/1',   0,   'We are hiring',  0),
    (10, 0, 2, 'carol', TIMESTAMP '2024-01-01 08:10:00', 'first reply',  0, 1,    NULL,                          NULL, NULL,           0),
    (11, 0, 2, 'dave',  TIMESTAMP '2024-01-01 08:20:00', 'nested reply', 0, 10,   NULL,                          NULL, NULL,           0),
    (12, 0, 2, 'erin',  TIMESTAMP '2024-01-01 09:45:00', 'on show hn',   0, 2,    NULL,                          NULL, NULL,           0),
    (13, 0, 2, 'frank', TIMESTAMP '2024-01-01 10:00:00', 'orphan',       0, 999,  NULL,                          NULL, NULL,           0),
    (20, 1, 1, 'gone',  TIMESTAMP '2024-01-01 07:00:00', NULL,           0, NULL, NULL,                          5,    'deleted story', 0),
    (21, 0, 2, 'spam',  TIMESTAMP '2024-01-01 11:00:00', 'flagged',      1, 1,    NULL,                          NULL, NULL,           0)
`;
const FIXTURE_COLS = '(id, deleted, type, "by", time, text, dead, parent, url, score, title, descendants)';

test('prep splits, derives, and resolves root stories', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hn-prep-'));
  const con = await openConnection();
  try {
    const fixture = path.join(dir, 'fixture.parquet');
    await con.run(
      `COPY (SELECT * FROM (${FIXTURE_ROWS}) AS t${FIXTURE_COLS}) TO ${quotedString(fixture)} (FORMAT parquet);`
    );

    const stats = await buildData(con, { sourceFiles: [fixture], outDir: dir });

    // 3 live stories/jobs (1,2,3); deleted story 20 excluded.
    assert.equal(stats.stories, 3, 'story count');
    // 4 live comments (10,11,12,13); dead comment 21 excluded.
    assert.equal(stats.comments, 4, 'comment count');
    // 10->1, 11->1, 12->2 resolve; 13 (orphan) does not.
    assert.equal(stats.resolved, 3, 'resolved count');
    assert.equal(stats.resolutionRate, 0.75, 'resolution rate');

    const stories = (
      await con.runAndReadAll(
        `SELECT id, category, domain FROM read_parquet(${quotedString(stats.storiesPath)}) ORDER BY id`
      )
    ).getRowObjects();
    assert.deepEqual(stories.map((s) => Number(s.id)), [1, 2, 3]);
    assert.deepEqual(
      stories.map((s) => s.category),
      ['Ask HN', 'Show HN', 'Job']
    );
    // www. stripped; host only.
    assert.equal(stories[1].domain, 'example.com', 'domain of story 2');
    assert.equal(stories[0].domain, null, 'text post has no domain');

    const roots = Object.fromEntries(
      (
        await con.runAndReadAll(
          `SELECT id, root_story_id FROM read_parquet(${quotedString(stats.commentsPath)}) ORDER BY id`
        )
      )
        .getRowObjects()
        .map((r) => [Number(r.id), r.root_story_id == null ? null : Number(r.root_story_id)])
    );
    assert.equal(roots[10], 1, 'top-level comment roots to its story');
    assert.equal(roots[11], 1, 'nested comment roots to the story');
    assert.equal(roots[12], 2, 'comment on show hn');
    assert.equal(roots[13], null, 'orphan comment has no root in window');
  } finally {
    con.closeSync?.();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Live score refresh ──────────────────────────────────────────────────────
// The upstream dataset captures `score` and `descendants` at (or near) ingest
// and never updates them, so a story that later drew 1,100 comments still
// reads as the handful it had minutes after posting. `refreshLiveScores` reads
// the current values back from the HN API. Every test here injects its own
// fetch — the ETL must stay hermetic.

/** Build a minimal `items` table with the columns refreshLiveScores touches. */
async function seedItems(con, rows) {
  await con.run(`
    CREATE OR REPLACE TABLE items (
      id BIGINT, type INTEGER, score INTEGER, descendants INTEGER
    );
  `);
  const values = rows
    .map((r) => `(${r.id}, ${r.type}, ${r.score ?? 'NULL'}, ${r.descendants ?? 'NULL'})`)
    .join(', ');
  if (values) await con.run(`INSERT INTO items VALUES ${values};`);
}

const readItems = async (con) =>
  Object.fromEntries(
    (await con.runAndReadAll('SELECT id, score, descendants FROM items ORDER BY id'))
      .getRowObjects()
      .map((r) => [Number(r.id), [Number(r.score), Number(r.descendants)]])
  );

/** A fake HN API. `live` maps id -> {score, descendants}; absent ids 404 as null. */
const fakeApi = (live) => async (url) => {
  const id = Number(url.match(/item\/(\d+)\.json/)[1]);
  return { ok: true, json: async () => (live[id] ? { id, ...live[id] } : null) };
};

test('refreshLiveScores replaces frozen scores with current ones', async () => {
  const con = await openConnection();
  try {
    await seedItems(con, [
      { id: 1, type: 1, score: 368, descendants: 231 }, // story: badly stale
      { id: 2, type: 5, score: 1, descendants: 0 },     // job: also refreshed
      { id: 3, type: 2, score: null, descendants: null }, // comment: never fetched
    ]);

    const stats = await refreshLiveScores(con, {
      fetchImpl: fakeApi({ 1: { score: 1561, descendants: 1113 }, 2: { score: 4, descendants: 2 } }),
      concurrency: 2,
    });

    const items = await readItems(con);
    assert.deepEqual(items[1], [1561, 1113], 'story score and descendants refreshed');
    assert.deepEqual(items[2], [4, 2], 'job refreshed too');
    assert.equal(stats.fetched, 2, 'only stories and jobs are fetched');
    assert.equal(stats.updated, 2);
    assert.equal(stats.failed, 0);
  } finally {
    con.closeSync?.();
  }
});

test('refreshLiveScores retries a transient failure and then succeeds', async () => {
  const con = await openConnection();
  try {
    await seedItems(con, [{ id: 1, type: 1, score: 10, descendants: 1 }]);
    let attempts = 0;
    const flaky = async (url) => {
      if (++attempts < 3) throw new Error('ECONNRESET');
      return fakeApi({ 1: { score: 900, descendants: 400 } })(url);
    };

    const stats = await refreshLiveScores(con, { fetchImpl: flaky, concurrency: 1, retryDelayMs: 1 });

    assert.equal(attempts, 3, 'retried twice before succeeding');
    assert.deepEqual((await readItems(con))[1], [900, 400]);
    assert.equal(stats.failed, 0);
  } finally {
    con.closeSync?.();
  }
});

test('refreshLiveScores leaves an unknown item at its original values', async () => {
  const con = await openConnection();
  try {
    // A story deleted since ingest: the API returns null. Keeping the stale
    // number is right — inventing one would be worse.
    await seedItems(con, [
      { id: 1, type: 1, score: 10, descendants: 1 },
      { id: 2, type: 1, score: 20, descendants: 2 },
    ]);

    const stats = await refreshLiveScores(con, {
      fetchImpl: fakeApi({ 1: { score: 99, descendants: 50 } }),
      concurrency: 2,
    });

    const items = await readItems(con);
    assert.deepEqual(items[1], [99, 50], 'known item refreshed');
    assert.deepEqual(items[2], [20, 2], 'unknown item untouched');
    assert.equal(stats.missing, 1);
    assert.equal(stats.failed, 0, 'a deleted item is missing, not a failure');
  } finally {
    con.closeSync?.();
  }
});

test('refreshLiveScores throws when too many fetches fail', async () => {
  const con = await openConnection();
  try {
    await seedItems(con, Array.from({ length: 10 }, (_, i) => ({ id: i + 1, type: 1, score: 1, descendants: 0 })));
    const live = { 1: { score: 5, descendants: 5 } };
    const mostlyBroken = async (url) => {
      const id = Number(url.match(/item\/(\d+)\.json/)[1]);
      if (!live[id]) throw new Error('503');
      return fakeApi(live)(url);
    };

    // Silently shipping data that is 90% stale would be worse than failing the
    // build — the numbers would look authoritative and be wrong.
    await assert.rejects(
      () => refreshLiveScores(con, { fetchImpl: mostlyBroken, concurrency: 2, retryDelayMs: 1, maxFailureRate: 0.05 }),
      /refresh failed for 9\/10/
    );
  } finally {
    con.closeSync?.();
  }
});

test('buildData wires the refresh through to stories.parquet', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hn-prep-live-'));
  const con = await openConnection();
  try {
    const fixture = path.join(dir, 'fixture.parquet');
    await con.run(
      `COPY (SELECT * FROM (${FIXTURE_ROWS}) AS t${FIXTURE_COLS}) TO ${quotedString(fixture)} (FORMAT parquet);`
    );

    const stats = await buildData(con, {
      sourceFiles: [fixture],
      outDir: dir,
      refreshScores: true,
      fetchImpl: fakeApi({
        1: { score: 900, descendants: 450 },
        2: { score: 800, descendants: 350 },
        3: { score: 0, descendants: 0 },
      }),
    });

    const stories = Object.fromEntries(
      (
        await con.runAndReadAll(
          `SELECT id, score, descendants FROM read_parquet(${quotedString(stats.storiesPath)})`
        )
      )
        .getRowObjects()
        .map((r) => [Number(r.id), [Number(r.score), Number(r.descendants)]])
    );
    assert.deepEqual(stories[1], [900, 450], 'fixture story 1 carries live numbers');
    assert.deepEqual(stories[2], [800, 350]);
    assert.equal(stats.refreshed.updated, 3);
  } finally {
    con.closeSync?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildData does not touch the network unless asked', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hn-prep-nonet-'));
  const con = await openConnection();
  try {
    const fixture = path.join(dir, 'fixture.parquet');
    await con.run(
      `COPY (SELECT * FROM (${FIXTURE_ROWS}) AS t${FIXTURE_COLS}) TO ${quotedString(fixture)} (FORMAT parquet);`
    );
    const stats = await buildData(con, {
      sourceFiles: [fixture],
      outDir: dir,
      fetchImpl: () => assert.fail('buildData fetched with refreshScores off'),
    });
    assert.equal(stats.refreshed, null);
  } finally {
    con.closeSync?.();
    await rm(dir, { recursive: true, force: true });
  }
});
