// The refresh scheduler's staleness guard. The container runs a refresh at boot
// as well as on the interval, so `refresh()` has to decide for itself whether
// there is anything to do — otherwise a container that restarts more often than
// the interval rebuilds the whole slice, and re-fetches every score from the HN
// API, on every restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDue } from '../prep/refresh.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-09-04T12:00:00Z');
const ago = (ms) => ({ refreshedAt: new Date(now - ms).toISOString() });

test('data younger than the interval is not due', () => {
  assert.equal(isDue(ago(3 * HOUR), { now, minAgeMs: DAY }), false);
});

test('data older than the interval is due', () => {
  assert.equal(isDue(ago(DAY + HOUR), { now, minAgeMs: DAY }), true);
});

test('data exactly at the interval is due', () => {
  // The boot refresh lands a shade after the interval elapses; an off-by-one
  // here would push every scheduled run a whole interval late.
  assert.equal(isDue(ago(DAY), { now, minAgeMs: DAY }), true);
});

test('data with no usable timestamp is due', () => {
  // A slice built before the marker existed, or a truncated write. Rebuilding
  // is the safe direction: the alternative is serving unknown-age data forever.
  for (const meta of [{}, null, undefined, { refreshedAt: 'not a date' }]) {
    assert.equal(isDue(meta, { now, minAgeMs: DAY }), true, `metadata ${JSON.stringify(meta)}`);
  }
});

test('a timestamp from the future does not block a refresh forever', () => {
  // Clock skew between the build host and the container. Treat it as due
  // rather than letting a bad marker pin the data in place.
  assert.equal(isDue(ago(-2 * DAY), { now, minAgeMs: DAY }), true);
});
