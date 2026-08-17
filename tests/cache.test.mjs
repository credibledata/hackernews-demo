import test from 'node:test';
import assert from 'node:assert/strict';
import { cached } from '../app/server/cache.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
