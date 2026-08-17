// The "under the hood" trace: every step the agent took, with the queries
// hydrated into something the panel can show (SQL + rows), and one of them
// marked as the result the answer rests on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrace, MAX_HYDRATED } from '../app/server/trace.mjs';

/** A malloy-interfaces Result with `n` rows — only the row count matters here. */
const resultWith = (n) => ({
  schema: { fields: [{ kind: 'dimension', name: 'x', type: { kind: 'string_type' } }] },
  data: { kind: 'array_cell', array_value: Array.from({ length: n }, () => ({ record_value: [] })) },
  sql: 'SELECT 1',
});

const step = (detail, ok = true) => ({ kind: 'query', detail, ok });
const toolStep = (detail, argument) => ({ kind: 'tool', detail, argument, ok: true });

/** Hydration doubles: `run` answers from a table of query -> row count. */
function fakes(rowsByQuery) {
  const ran = [];
  return {
    ran,
    run: async (q) => {
      ran.push(q);
      const n = rowsByQuery[q];
      return n === undefined ? null : resultWith(n);
    },
    compile: async () => 'SELECT compiled',
  };
}

test('every successful query gets its rows and SQL; tool steps are left alone', async () => {
  const f = fakes({ 'run: stories -> score_by_hour': 24, 'run: stories -> by_category': 4 });
  const { steps } = await buildTrace(
    [
      toolStep('malloy_getContext', 'story scores by hour'),
      step('run: stories -> score_by_hour'),
      step('run: stories -> by_category'),
    ],
    f
  );

  assert.equal(steps.length, 3);
  assert.equal(steps[0].data, undefined, 'a discovery step has no result to show');
  assert.equal(steps[0].argument, 'story scores by hour');
  assert.equal(steps[1].rows, 24);
  assert.equal(steps[1].sql, 'SELECT 1', "the run's own SQL is used when it carries one");
  assert.ok(steps[1].data);
  assert.match(steps[1].interpretation, /Pacific/);
  assert.equal(steps[2].rows, 4);
});

test('a failed query keeps its place in the trace but is not re-run', async () => {
  const f = fakes({ 'run: stories -> by_category': 4 });
  const { steps } = await buildTrace([step('run: stories -> nope', false), step('run: stories -> by_category')], f);

  assert.deepEqual(f.ran, ['run: stories -> by_category']);
  assert.equal(steps[0].ok, false);
  assert.equal(steps[0].data, undefined);
});

test('a query the agent ran twice is only re-run once', async () => {
  const f = fakes({ 'run: stories -> by_category': 4 });
  const { steps } = await buildTrace([step('run: stories -> by_category'), step('run: stories -> by_category')], f);

  assert.deepEqual(f.ran, ['run: stories -> by_category']);
  assert.equal(steps[0].rows, 4);
  assert.equal(steps[1].rows, 4, 'both steps still show their result');
});

// Which result the answer rests on. The agent often finishes with a small
// lookup — a baseline average, a total — after the query that actually answers
// the question, so "the last one" is the wrong pick for the chart.
test('the primary result is the last query that returned more than one row', async () => {
  const f = fakes({
    'run: stories -> score_by_hour': 24,
    'run: stories -> { aggregate: avg_score }': 1,
  });
  const { steps, primary } = await buildTrace(
    [step('run: stories -> score_by_hour'), step('run: stories -> { aggregate: avg_score }')],
    f
  );

  assert.equal(primary, 0);
  assert.equal(steps[primary].detail, 'run: stories -> score_by_hour');
});

test('a single-row answer is still the primary when nothing richer ran', async () => {
  const f = fakes({ 'run: stories -> { aggregate: avg_score }': 1 });
  const { primary } = await buildTrace([step('run: stories -> { aggregate: avg_score }')], f);
  assert.equal(primary, 0);
});

test('a run with no query at all has no primary', async () => {
  const { steps, primary } = await buildTrace([toolStep('malloy_getContext', 'anything')], fakes({}));
  assert.equal(primary, -1);
  assert.equal(steps.length, 1);
});

test('a query that fails to re-run is reported, not dropped', async () => {
  const f = fakes({}); // run() returns null for everything
  const { steps, primary } = await buildTrace([step('run: stories -> by_category')], f);

  assert.equal(steps[0].data, undefined);
  assert.equal(primary, -1, 'nothing renderable means no primary');
});

test('only the most recent queries are re-run, so a long chain stays bounded', async () => {
  const queries = Array.from({ length: MAX_HYDRATED + 3 }, (_, i) => `run: stories -> q${i}`);
  const f = fakes(Object.fromEntries(queries.map((q) => [q, 2])));
  const { steps } = await buildTrace(queries.map((q) => step(q)), f);

  assert.equal(f.ran.length, MAX_HYDRATED);
  assert.equal(steps[0].data, undefined, 'the oldest steps still show their Malloy');
  assert.equal(steps[0].detail, 'run: stories -> q0');
  assert.ok(steps.at(-1).data, 'the newest are hydrated');
});
