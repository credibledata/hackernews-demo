// Single-flight TTL cache for the things this server derives from the data
// slice (starter questions, dataset scope). They share the same shape: an
// expensive build, one copy for everyone, and a rebuild only when the slice
// might have moved.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where persisted entries live. Deliberately outside package/data, which the
// daily refresh replaces wholesale (prep/refresh.mjs swaps the symlink).
const CACHE_DIR =
  process.env.HN_CACHE_DIR ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.cache');

/** Path for a persisted cache entry, e.g. cacheFile('suggestions.json'). */
export const cacheFile = (name) => path.join(CACHE_DIR, name);

/** Last persisted entry, or null if there is none / it is unusable. */
function load(file, label) {
  try {
    const { value, at } = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value == null || !Number.isFinite(at)) return null;
    // Cap at now: a clock that jumped forward once must not pin the entry.
    return { value, at: Math.min(at, Date.now()), ok: true };
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error(`[${label}] cache read`, e?.message || e);
    return null;
  }
}

function save(file, { value, at }, label) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ value, at }));
  } catch (e) {
    console.error(`[${label}] cache write`, e?.message || e);
  }
}

/**
 * Wrap an async producer so it is built at most once per TTL and once at a time.
 *
 * A failed or empty build is cached too — otherwise every request retries a
 * broken call — but only for `retryMs`, so a warm-up that raced the data layer
 * coming up doesn't pin the fallback for the whole TTL.
 *
 * With `file`, the last good value and its age are kept on disk, so the TTL
 * spans restarts instead of resetting with the process. Disk problems only cost
 * a rebuild — they never fail a read.
 *
 * @param {() => Promise<any>} produce  builds the value; null/undefined = failed
 * @param {{ttlMs: number, retryMs?: number, fallback?: any, label?: string, file?: string}} opts
 * @returns {() => Promise<any>} reader; never rejects
 */
export function cached(produce, { ttlMs, retryMs = 60_000, fallback = null, label = 'cache', file = null }) {
  let entry = file ? load(file, label) : null; // { value, at, ok }
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
        if (file && entry.ok) save(file, entry, label); // only persist real builds
        inflight = null;
        return entry.value;
      });
    return inflight;
  };
}
