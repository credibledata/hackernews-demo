// Admission control for the chat endpoint. Every accepted message costs real
// money (a model turn plus up to MAX_TURNS tool round-trips), so this guards
// two independent resources:
//
//   · a per-IP token bucket   — stops one client draining the budget
//   · a global in-flight cap  — stops the box (and the model API) saturating
//
// The clock is injectable so the behaviour is testable without sleeping.

/**
 * @param {object} opts
 * @param {number} opts.capacity      burst size per IP
 * @param {number} opts.refillPerSec  sustained rate per IP
 * @param {number} opts.maxInFlight   concurrent requests across all clients
 * @param {number} [opts.idleEvictMs] drop buckets untouched for this long
 * @param {() => number} [opts.now]   clock, for tests
 */
export function createRateLimiter({
  capacity,
  refillPerSec,
  maxInFlight,
  idleEvictMs = 10 * 60 * 1000,
  now = () => Date.now(),
}) {
  /** @type {Map<string, {tokens: number, seen: number, held: number}>} */
  const buckets = new Map();
  let inFlight = 0;

  // Buckets are created per client IP, so without eviction this map is an
  // unbounded leak under the exact traffic spike it exists to survive. Sweeping
  // on acquire keeps it self-maintaining with no timer; throttling by time
  // keeps that from being an O(n) walk on every single request.
  const sweepIntervalMs = idleEvictMs / 2;
  let lastSweep = 0;
  function sweep(at) {
    if (at - lastSweep < sweepIntervalMs) return;
    lastSweep = at;
    for (const [key, b] of buckets) {
      if (b.held === 0 && at - b.seen > idleEvictMs) buckets.delete(key);
    }
  }

  function bucketFor(key, at) {
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, seen: at, held: 0 };
      buckets.set(key, b);
      return b;
    }
    // Refill for elapsed time, capped at capacity — an idle client gets a full
    // burst back but cannot bank more than that.
    const elapsedSec = (at - b.seen) / 1000;
    b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
    b.seen = at;
    return b;
  }

  return {
    /**
     * Try to admit a request.
     * @returns {{ok: true, release: () => void}
     *          |{ok: false, reason: 'rate'|'busy', retryAfterSec: number}}
     */
    acquire(key) {
      const at = now();
      sweep(at);
      const b = bucketFor(key, at);

      if (b.tokens < 1) {
        // Time until the next whole token is available.
        return { ok: false, reason: 'rate', retryAfterSec: Math.ceil((1 - b.tokens) / refillPerSec) };
      }
      if (inFlight >= maxInFlight) {
        // Don't spend a token on a request we're refusing.
        return { ok: false, reason: 'busy', retryAfterSec: 5 };
      }

      b.tokens -= 1;
      b.held += 1;
      inFlight += 1;

      let released = false;
      return {
        ok: true,
        release() {
          if (released) return; // idempotent: double-release must not free a phantom slot
          released = true;
          inFlight -= 1;
          const cur = buckets.get(key);
          if (cur) cur.held -= 1;
        },
      };
    },

    inFlight: () => inFlight,
    size: () => buckets.size,
  };
}
