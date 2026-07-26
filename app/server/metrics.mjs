// In-process counters for the chat endpoint. Enough to answer "is it actually
// serving?" during a traffic spike without adding a metrics dependency or a
// scrape target: lifetime counters plus a bounded window of recent answer
// latencies for p50/p95.
//
// Deliberately not persisted — these reset with the process, which is the right
// granularity for a single-container demo.

const DEFAULT_SAMPLE_SIZE = 500;

/** Nearest-rank percentile over an already-sorted array. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function createMetrics({
  sampleSize = DEFAULT_SAMPLE_SIZE,
  now = () => Date.now(),
  startedAt = now(),
} = {}) {
  const counters = {
    messages_started: 0,
    answers_completed: 0,
    served_from_cache: 0,
    errors: 0,
    aborted: 0,
  };
  const limited = { rate: 0, busy: 0 };
  let inFlight = 0;

  // Fixed-size ring: recent latencies matter, a lifetime histogram doesn't.
  const samples = new Array(sampleSize);
  let written = 0;

  const endOne = () => {
    inFlight = Math.max(0, inFlight - 1);
  };

  return {
    started() {
      counters.messages_started += 1;
      inFlight += 1;
    },
    completed(ms) {
      counters.answers_completed += 1;
      endOne();
      samples[written % sampleSize] = ms;
      written += 1;
    },
    /** A cache hit: a real answer served without a model turn. Deliberately
     *  kept out of the latency window, which is there to show what a live
     *  answer costs — mixing in millisecond replays would flatter it. */
    servedFromCache() {
      counters.served_from_cache += 1;
      endOne();
    },
    errored() {
      counters.errors += 1;
      endOne();
    },
    abortedRequest() {
      counters.aborted += 1;
      endOne();
    },
    /** A request refused before it started work. @param {'rate'|'busy'} reason */
    limited(reason) {
      if (reason in limited) limited[reason] += 1;
    },

    snapshot() {
      const window = samples.slice(0, Math.min(written, sampleSize));
      const sorted = [...window].sort((a, b) => a - b);
      return {
        ...counters,
        rate_limited: { ...limited },
        in_flight: inFlight,
        uptime_ms: now() - startedAt,
        latency_ms: {
          count: sorted.length,
          min: sorted.length ? sorted[0] : null,
          max: sorted.length ? sorted[sorted.length - 1] : null,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
        },
      };
    },
  };
}
