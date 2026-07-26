// Hermetic tests for the chat rate limiter. The clock is injected, so these
// assert real refill/eviction behaviour without sleeping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../app/server/ratelimit.mjs';

/** Limiter with a controllable clock. */
function build(overrides = {}) {
  let clock = 0;
  const limiter = createRateLimiter({
    capacity: 3,
    refillPerSec: 1,
    maxInFlight: 2,
    idleEvictMs: 10_000,
    now: () => clock,
    ...overrides,
  });
  return { limiter, tick: (ms) => (clock += ms), at: () => clock };
}

test('per-IP bucket allows a burst up to capacity, then rejects', () => {
  const { limiter } = build();

  // Release each grant immediately so the in-flight cap is never what blocks —
  // a rejection here can only be the rate limit.
  for (let i = 0; i < 3; i++) {
    const grant = limiter.acquire('1.2.3.4');
    assert.equal(grant.ok, true, `burst request ${i + 1} should be admitted`);
    grant.release();
  }

  const denied = limiter.acquire('1.2.3.4');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'rate');
  assert.ok(denied.retryAfterSec >= 1, 'should suggest a retry delay');
});

test('tokens refill over time at the configured rate', () => {
  const { limiter, tick } = build();

  for (let i = 0; i < 3; i++) limiter.acquire('1.2.3.4').release();
  assert.equal(limiter.acquire('1.2.3.4').ok, false);

  tick(1000); // one token back
  const grant = limiter.acquire('1.2.3.4');
  assert.equal(grant.ok, true);
  grant.release();
  assert.equal(limiter.acquire('1.2.3.4').ok, false, 'only one token had refilled');
});

test('refill is capped at capacity so idle clients cannot bank tokens', () => {
  const { limiter, tick } = build();

  limiter.acquire('1.2.3.4').release();
  tick(60_000); // idle a long time

  for (let i = 0; i < 3; i++) {
    const g = limiter.acquire('1.2.3.4');
    assert.equal(g.ok, true, `request ${i + 1} within capacity`);
    g.release();
  }
  assert.equal(limiter.acquire('1.2.3.4').ok, false, 'cannot exceed capacity');
});

test('buckets are per-IP and do not interfere', () => {
  const { limiter } = build();

  for (let i = 0; i < 3; i++) limiter.acquire('1.1.1.1').release();
  assert.equal(limiter.acquire('1.1.1.1').ok, false);

  const other = limiter.acquire('2.2.2.2');
  assert.equal(other.ok, true, 'a different IP has its own bucket');
  other.release();
});

test('global in-flight cap rejects with reason "busy" and recovers on release', () => {
  const { limiter } = build();

  const a = limiter.acquire('1.1.1.1');
  const b = limiter.acquire('2.2.2.2');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  // Third caller has tokens available but the box is saturated.
  const c = limiter.acquire('3.3.3.3');
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'busy');

  a.release();
  const d = limiter.acquire('3.3.3.3');
  assert.equal(d.ok, true, 'a slot freed up');
  d.release();
  b.release();
  assert.equal(limiter.inFlight(), 0);
});

test('release is idempotent so a double-release cannot free phantom slots', () => {
  const { limiter } = build();

  const a = limiter.acquire('1.1.1.1');
  a.release();
  a.release();
  assert.equal(limiter.inFlight(), 0);

  const b = limiter.acquire('2.2.2.2');
  const c = limiter.acquire('3.3.3.3');
  assert.equal(b.ok, true);
  assert.equal(c.ok, true);
  assert.equal(limiter.acquire('4.4.4.4').ok, false, 'cap still enforced at 2');
  b.release();
  c.release();
});

test('idle buckets are evicted so the map cannot grow without bound', () => {
  const { limiter, tick } = build();

  for (let i = 0; i < 50; i++) limiter.acquire(`10.0.0.${i}`).release();
  assert.equal(limiter.size(), 50);

  tick(11_000); // past idleEvictMs
  limiter.acquire('10.0.1.1').release(); // any call triggers a sweep

  assert.equal(limiter.size(), 1, 'stale buckets swept, only the fresh one remains');
});

test('a bucket still holding in-flight work is not evicted', () => {
  const { limiter, tick } = build();

  const held = limiter.acquire('9.9.9.9');
  tick(11_000);
  limiter.acquire('8.8.8.8').release();

  assert.equal(limiter.size(), 2, 'the in-flight bucket survives the sweep');
  held.release();
});
