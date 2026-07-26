// Cache of completed answers, keyed on the question text.
//
// The traffic mix this demo will actually see is dominated by a handful of
// questions: every first-time visitor clicks one of five starter chips, and a
// shared ?q= link re-asks the same question for every person who opens it.
// Without this, each of those is a fresh model turn plus tool round-trips —
// cost that scales linearly with visitors for an identical answer.
//
// Only first-turn questions are cached (see index.mjs): a follow-up depends on
// the conversation so far, so replaying an answer out of context would be wrong.

const NORMALISE = /\s+/g;

/** Case- and whitespace-insensitive key, so trivially different phrasings share an entry. */
function keyFor(question) {
  if (typeof question !== 'string') return null;
  const key = question.trim().toLowerCase().replace(NORMALISE, ' ');
  return key || null;
}

export function createAnswerCache({
  ttlMs = 60 * 60 * 1000,
  maxEntries = 200,
  now = () => Date.now(),
} = {}) {
  // Map preserves insertion order, which is all an LRU needs: delete + re-set
  // moves an entry to the end, so the oldest key is always the first one.
  const entries = new Map();
  let hits = 0;
  let misses = 0;

  return {
    /** @returns {null | {answer: string, malloyQuery: string, sql: string|null, data: any, steps: any[]}} */
    get(question) {
      const key = keyFor(question);
      if (!key) return null;

      const hit = entries.get(key);
      if (!hit) {
        misses += 1;
        return null;
      }
      if (now() - hit.at > ttlMs) {
        entries.delete(key); // drop it rather than leave it to rot
        misses += 1;
        return null;
      }

      // Touch: mark as most recently used.
      entries.delete(key);
      entries.set(key, hit);
      hits += 1;
      return hit.value;
    },

    set(question, value) {
      const key = keyFor(question);
      if (!key) return;

      entries.delete(key); // re-set moves to the end and restarts the TTL
      entries.set(key, { value, at: now() });

      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        entries.delete(oldest);
      }
    },

    /** Called when the served data slice changes — cached numbers would be stale. */
    clear() {
      entries.clear();
    },

    size: () => entries.size,
    stats: () => ({ hits, misses, entries: entries.size }),
  };
}
