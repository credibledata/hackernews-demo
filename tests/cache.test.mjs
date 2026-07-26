import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cached } from '../app/server/cache.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh cache-file path in a temp dir, removed when the test ends. */
function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hn-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'value.json');
}

test('builds once and serves the cached value within the TTL', async () => {
  let builds = 0;
  const read = cached(async () => ++builds, { ttlMs: 10_000 });
  assert.equal(await read(), 1);
  assert.equal(await read(), 1);
  assert.equal(builds, 1);
});

test('concurrent readers share one build', async () => {
  let builds = 0;
  const read = cached(
    async () => {
      builds++;
      await sleep(20);
      return 'v';
    },
    { ttlMs: 10_000 }
  );
  const all = await Promise.all([read(), read(), read()]);
  assert.deepEqual(all, ['v', 'v', 'v']);
  assert.equal(builds, 1);
});

test('rebuilds after the TTL expires', async () => {
  let builds = 0;
  const read = cached(async () => ++builds, { ttlMs: 15 });
  assert.equal(await read(), 1);
  await sleep(25);
  assert.equal(await read(), 2);
});

test('a failed build serves the fallback and retries sooner than the TTL', async () => {
  let builds = 0;
  const read = cached(
    async () => {
      builds++;
      if (builds === 1) throw new Error('publisher down');
      return 'live';
    },
    { ttlMs: 60_000, retryMs: 15, fallback: 'fallback', label: 'test' }
  );

  assert.equal(await read(), 'fallback');
  assert.equal(await read(), 'fallback', 'retries are throttled, not hammered');
  assert.equal(builds, 1);

  await sleep(25);
  assert.equal(await read(), 'live');
});

test('a later failure keeps the last good value rather than the fallback', async () => {
  let builds = 0;
  const read = cached(
    async () => {
      builds++;
      return builds === 1 ? 'good' : null;
    },
    { ttlMs: 15, retryMs: 15, fallback: 'fallback' }
  );

  assert.equal(await read(), 'good');
  await sleep(25);
  assert.equal(await read(), 'good');
});

// ── Persistence: the TTL has to survive a restart, otherwise a weekly rebuild
//    is really a rebuild-per-process.

test('a persisted value is reused by a new reader within the TTL', async (t) => {
  const file = tmpFile(t);
  let builds = 0;
  const build = async () => `v${++builds}`;

  assert.equal(await cached(build, { ttlMs: 60_000, file })(), 'v1');
  // A second reader = a process restart: same file, nothing in memory.
  assert.equal(await cached(build, { ttlMs: 60_000, file })(), 'v1');
  assert.equal(builds, 1, 'the restart must not rebuild');
});

test('a persisted value older than the TTL is rebuilt', async (t) => {
  const file = tmpFile(t);
  let builds = 0;
  const build = async () => `v${++builds}`;

  assert.equal(await cached(build, { ttlMs: 15, file })(), 'v1');
  await sleep(25);
  assert.equal(await cached(build, { ttlMs: 15, file })(), 'v2');
  // …and the rebuild is what a later restart picks up.
  assert.equal(await cached(build, { ttlMs: 60_000, file })(), 'v2');
  assert.equal(builds, 2);
});

test('an unreadable or corrupt cache file just means a cold start', async (t) => {
  const file = tmpFile(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');

  const read = cached(async () => 'fresh', { ttlMs: 60_000, file, label: 'test' });
  assert.equal(await read(), 'fresh');
  assert.equal(await cached(async () => 'other', { ttlMs: 60_000, file })(), 'fresh');
});

test('a failed build is not persisted', async (t) => {
  const file = tmpFile(t);
  let builds = 0;
  const flaky = async () => {
    if (++builds === 1) throw new Error('publisher down');
    return 'live';
  };

  assert.equal(await cached(flaky, { ttlMs: 60_000, file, fallback: 'fb', label: 'test' })(), 'fb');
  assert.equal(await cached(flaky, { ttlMs: 60_000, file, fallback: 'fb' })(), 'live');
  assert.equal(await cached(flaky, { ttlMs: 60_000, file, fallback: 'fb' })(), 'live');
  assert.equal(builds, 2);
});
