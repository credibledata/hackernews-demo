// Thin REST helpers against the Publisher server, used to populate the
// "under the hood" panel: the compiled SQL for a Malloy query, and a clean
// renderable result payload for the chart.

import { config } from './config.mjs';

const modelBase = () =>
  `${config.restUrl}/environments/${config.environmentName}` +
  `/packages/${config.packageName}/models/${config.modelPath}`;

/** Compile a Malloy query and return the generated SQL (or null on failure). */
export async function compileSql(query) {
  try {
    const res = await fetch(`${modelBase()}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: query, includeSql: true }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.status === 'success' ? body.sql ?? null : null;
  } catch {
    return null;
  }
}

/** Run a Malloy query and return the Malloy result payload for rendering. */
export async function runQuery(query) {
  try {
    const res = await fetch(`${modelBase()}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    // `result` is a JSON string of the Malloy result (schema + data).
    return typeof body.result === 'string' ? JSON.parse(body.result) : body.result ?? null;
  } catch {
    return null;
  }
}
