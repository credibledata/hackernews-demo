// Hermetic tests for the answer cache. Clock is injected, so TTL behaviour is
// exact rather than timing-dependent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerCache } from '../app/server/answercache.mjs';

const payload = (answer) => ({ answer, malloyQuery: 'run: stories -> x', sql: 'SELECT 1', data: {}, steps: [] });

function build(overrides = {}) {
  let clock = 0;
  const cache = createAnswerCache({
    ttlMs: 1000,
    maxEntries: 3,
    now: () => clock,
    ...overrides,
  });
  return { cache, tick: (ms) => (clock += ms) };
}

test('a miss returns null and a set makes it retrievable', () => {
  const { cache } = build();
  assert.equal(cache.get('who posts most?'), null);
  cache.set('who posts most?', payload('alice'));
  assert.equal(cache.get('who posts most?').answer, 'alice');
});

test('lookup is insensitive to case, surrounding space and inner whitespace', () => {
  const { cache } = build();
  cache.set('Which domains score highest?', payload('reddit.com'));

  for (const variant of [
    'which domains score highest?',
    '  Which domains score highest?  ',
    'Which   domains    score highest?',
    'WHICH DOMAINS SCORE HIGHEST?',
    'Which domains score highest?\n',
  ]) {
    assert.equal(cache.get(variant)?.answer, 'reddit.com', `should hit for: ${JSON.stringify(variant)}`);
  }
});

test('different questions do not collide', () => {
  const { cache } = build();
  cache.set('question one', payload('1'));
  cache.set('question two', payload('2'));
  assert.equal(cache.get('question one').answer, '1');
  assert.equal(cache.get('question two').answer, '2');
});

test('entries expire once past the TTL', () => {
  const { cache, tick } = build();
  cache.set('q', payload('a'));

  tick(999);
  assert.equal(cache.get('q')?.answer, 'a', 'still fresh just before the TTL');

  tick(2);
  assert.equal(cache.get('q'), null, 'expired');
});

test('an expired entry is dropped, not merely hidden', () => {
  const { cache, tick } = build();
  cache.set('q', payload('a'));
  tick(2000);
  cache.get('q');
  assert.equal(cache.size(), 0, 'expired entry is evicted on read');
});

test('least-recently-used entry is evicted when full', () => {
  const { cache } = build(); // maxEntries: 3
  cache.set('a', payload('A'));
  cache.set('b', payload('B'));
  cache.set('c', payload('C'));

  cache.get('a'); // 'a' is now the most recently used, 'b' the least

  cache.set('d', payload('D'));
  assert.equal(cache.size(), 3);
  assert.equal(cache.get('b'), null, 'LRU entry evicted');
  assert.equal(cache.get('a')?.answer, 'A');
  assert.equal(cache.get('c')?.answer, 'C');
  assert.equal(cache.get('d')?.answer, 'D');
});

test('re-setting an existing question refreshes it rather than duplicating', () => {
  const { cache, tick } = build();
  cache.set('q', payload('old'));
  tick(900);
  cache.set('q', payload('new'));
  tick(900); // 1800 since first set, 900 since second

  assert.equal(cache.size(), 1);
  assert.equal(cache.get('q')?.answer, 'new', 'newer value, and its TTL restarted');
});

test('clear empties the cache — used when the data slice is swapped', () => {
  const { cache } = build();
  cache.set('a', payload('A'));
  cache.set('b', payload('B'));
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.get('a'), null);
});

test('blank or non-string questions are never cached', () => {
  const { cache } = build();
  cache.set('   ', payload('x'));
  cache.set('', payload('x'));
  cache.set(null, payload('x'));
  assert.equal(cache.size(), 0);
  assert.equal(cache.get('   '), null);
  assert.equal(cache.get(null), null);
});

test('stats report hits and misses for the metrics endpoint', () => {
  const { cache } = build();
  cache.set('q', payload('a'));
  cache.get('q');
  cache.get('q');
  cache.get('nope');

  const s = cache.stats();
  assert.equal(s.hits, 2);
  assert.equal(s.misses, 1);
  assert.equal(s.entries, 1);
});
