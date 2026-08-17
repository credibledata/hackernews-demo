// Single-flight TTL cache for the things this server derives from the data
// slice (currently the dataset scope): an expensive build, one copy for
// everyone, and a rebuild only when the slice might have moved.

/**
 * Wrap an async producer so it is built at most once per TTL and once at a time.
 *
 * A failed or empty build is cached too — otherwise every request retries a
 * broken call — but only for `retryMs`, so a warm-up that raced the data layer
 * coming up doesn't pin the fallback for the whole TTL.
 *
 * @param {() => Promise<any>} produce  builds the value; null/undefined = failed
 * @param {{ttlMs: number, retryMs?: number, fallback?: any, label?: string}} opts
 * @returns {() => Promise<any>} reader; never rejects
 */
export function cached(produce, { ttlMs, retryMs = 60_000, fallback = null, label = 'cache' }) {
  let entry = null; // { value, at, ok }
  let inflight = null;

  return function read() {
    if (entry && Date.now() - entry.at < (entry.ok ? ttlMs : retryMs)) return Promise.resolve(entry.value);
    inflight ??= Promise.resolve()
      .then(produce)
      .catch((e) => {
        console.error(`[${label}]`, e?.message || e);
        return null;
      })
      .then((value) => {
        // Keep the last good value rather than falling back to a worse one.
        entry = { value: value ?? entry?.value ?? fallback, at: Date.now(), ok: value != null };
        inflight = null;
        return entry.value;
      });
    return inflight;
  };
}
