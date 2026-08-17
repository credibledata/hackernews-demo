// Turns the agent's tool trace into what the "under the hood" panel shows: the
// steps in order, each query carrying the SQL it compiled to and the rows it
// returned, and one step marked as the result the answer rests on.
//
// The queries are re-run over REST rather than read out of the MCP tool
// response: Publisher shapes that payload for the model to read (flat rows),
// not for the renderer, which needs the malloy-interfaces Result — and it
// carries no SQL. A second local DuckDB pass over a query that already ran is
// cheap; sniffing the tool payload for a renderable shape is what silently
// broke the chart the last time that output changed.

import { compileSql, runQuery } from './publisher.mjs';
import { interpretationFor } from './interpretation.mjs';

// How many distinct queries are re-run for the panel. A long chain still shows
// every step and its Malloy; only the oldest lose their rows. Bounds both the
// work done after the answer and the size of the payload sent to the browser.
export const MAX_HYDRATED = 8;

const rowsOf = (data) => data?.data?.array_value?.length ?? 0;

/**
 * @param {{kind: 'query'|'tool', detail: string, argument?: string, ok: boolean}[]} steps
 * @param {{run?: typeof runQuery, compile?: typeof compileSql}} deps
 * @returns {Promise<{steps: object[], primary: number}>} primary is an index into
 *          steps, or -1 when nothing renderable ran.
 */
export async function buildTrace(steps, { run = runQuery, compile = compileSql } = {}) {
  // Distinct queries worth re-running, newest first — the agent repeats a query
  // often enough (a retry, a re-check) that running each one once matters more
  // than the cap does.
  const wanted = [];
  for (let i = steps.length - 1; i >= 0 && wanted.length < MAX_HYDRATED; i--) {
    const s = steps[i];
    if (s.kind === 'query' && s.ok && !wanted.includes(s.detail)) wanted.push(s.detail);
  }

  const ran = new Map(
    await Promise.all(
      wanted.map(async (query) => {
        const data = await run(query);
        if (!data) return [query, null];
        return [query, { sql: data.sql ?? (await compile(query)), data, rows: rowsOf(data) }];
      })
    )
  );

  const hydrated = steps.map((s) => {
    const result = s.kind === 'query' && s.ok ? ran.get(s.detail) : null;
    return result
      ? { ...s, ...result, interpretation: interpretationFor(s.detail) }
      : { ...s };
  });

  return { steps: hydrated, primary: pickPrimary(hydrated) };
}

/**
 * The step whose result the answer rests on: the last query that returned more
 * than one row. A run often ends with a small lookup — a baseline average, a
 * total — after the query that actually answers the question, and that is the
 * one the reader should land on. Falls back to the last renderable result.
 */
function pickPrimary(steps) {
  let fallback = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!steps[i].data) continue;
    if (steps[i].rows > 1) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}
