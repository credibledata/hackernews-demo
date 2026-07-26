// Hermetic tests for the chat metrics. No timers and no I/O — durations are
// passed in, so percentiles are exact and assertions can't flake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from '../app/server/metrics.mjs';

test('a fresh registry reports zeroes, not nulls', () => {
  const m = createMetrics();
  const s = m.snapshot();

  assert.equal(s.messages_started, 0);
  assert.equal(s.answers_completed, 0);
  assert.equal(s.errors, 0);
  assert.equal(s.aborted, 0);
  assert.equal(s.rate_limited.rate, 0);
  assert.equal(s.rate_limited.busy, 0);
  assert.equal(s.in_flight, 0);
  assert.equal(s.latency_ms.count, 0);
  assert.equal(s.latency_ms.p50, null, 'no samples means no percentile to report');
  assert.equal(s.latency_ms.p95, null);
});

test('counters track each outcome independently', () => {
  const m = createMetrics();

  m.started(); m.started(); m.started();
  m.completed(100);
  m.errored();
  m.abortedRequest();
  m.limited('rate');
  m.limited('busy');
  m.limited('rate');

  const s = m.snapshot();
  assert.equal(s.messages_started, 3);
  assert.equal(s.answers_completed, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.aborted, 1);
  assert.equal(s.rate_limited.rate, 2);
  assert.equal(s.rate_limited.busy, 1);
});

test('in-flight rises on start and falls on every terminal outcome', () => {
  const m = createMetrics();

  m.started(); m.started(); m.started(); m.started();
  assert.equal(m.snapshot().in_flight, 4);

  m.completed(50);
  assert.equal(m.snapshot().in_flight, 3);
  m.errored();
  assert.equal(m.snapshot().in_flight, 2);
  m.abortedRequest();
  assert.equal(m.snapshot().in_flight, 1);
  m.servedFromCache();
  assert.equal(m.snapshot().in_flight, 0, 'a cache hit is a terminal outcome too');
});

test('cache hits are counted but excluded from answer latency', () => {
  const m = createMetrics();
  m.started();
  m.completed(5000);
  m.started();
  m.servedFromCache();

  const s = m.snapshot();
  assert.equal(s.answers_completed, 1);
  assert.equal(s.served_from_cache, 1);
  assert.equal(s.latency_ms.count, 1, 'only the live answer is sampled');
  assert.equal(s.latency_ms.p50, 5000);
});

test('in-flight never goes negative if outcomes outnumber starts', () => {
  const m = createMetrics();
  m.completed(10);
  m.errored();
  assert.equal(m.snapshot().in_flight, 0);
});

test('a rejected request is counted but never enters in-flight', () => {
  const m = createMetrics();
  m.limited('busy');
  assert.equal(m.snapshot().in_flight, 0);
  assert.equal(m.snapshot().messages_started, 0, 'a 429 is not a started message');
});

test('percentiles are exact on a known distribution', () => {
  const m = createMetrics();
  // 1..100 ms
  for (let i = 1; i <= 100; i++) m.completed(i);

  const l = m.snapshot().latency_ms;
  assert.equal(l.count, 100);
  assert.equal(l.min, 1);
  assert.equal(l.max, 100);
  // Nearest-rank: p50 -> ceil(0.50*100)=50th value, p95 -> 95th value.
  assert.equal(l.p50, 50);
  assert.equal(l.p95, 95);
});

test('a single sample is its own p50 and p95', () => {
  const m = createMetrics();
  m.completed(42);
  const l = m.snapshot().latency_ms;
  assert.equal(l.p50, 42);
  assert.equal(l.p95, 42);
  assert.equal(l.min, 42);
  assert.equal(l.max, 42);
});

test('the ring buffer keeps only the most recent samples', () => {
  const m = createMetrics({ sampleSize: 10 });

  for (let i = 0; i < 10; i++) m.completed(1000); // evicted
  for (let i = 1; i <= 10; i++) m.completed(i); // survivors: 1..10

  const l = m.snapshot().latency_ms;
  assert.equal(l.count, 10, 'window is capped at sampleSize');
  assert.equal(l.max, 10, 'the 1000ms samples were evicted');
  assert.equal(l.p50, 5);

  // The lifetime counter is unaffected by the sampling window.
  assert.equal(m.snapshot().answers_completed, 20);
});

test('snapshot is a copy — callers cannot mutate internal state', () => {
  const m = createMetrics();
  m.started();
  const s = m.snapshot();
  s.messages_started = 999;
  s.rate_limited.rate = 999;
  assert.equal(m.snapshot().messages_started, 1);
  assert.equal(m.snapshot().rate_limited.rate, 0);
});

test('uptime is reported and non-negative', () => {
  const m = createMetrics({ now: () => 5000, startedAt: 1000 });
  assert.equal(m.snapshot().uptime_ms, 4000);
});
