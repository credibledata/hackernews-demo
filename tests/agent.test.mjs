// The agent loop's turn budget. A comparative question ("is X unusually high?")
// needs several queries plus their discovery and validation calls, so a run can
// use the whole budget. What must never happen is a run that spends the budget
// and returns nothing — the UI then draws the last query's table with no answer
// above it, which reads as a numeric non-answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, MAX_TURNS } from '../app/server/agent.mjs';

/** An MCP double: every tool call succeeds with a trivial payload, in the flat
 *  shape Publisher returns from malloy_executeQuery (rows + `_meta`). */
const mcp = {
  tools: [{ name: 'malloy_executeQuery', description: 'run', parameters: { type: 'object' } }],
  callTool: async () => ({
    text: '{"rows":[{"c":1}],"_meta":{"schema":{"fields":[]}},"_limit_hit":false}',
    isError: false,
  }),
};

/** An MCP double that plays a script of results, one per tool call, so a run can
 *  mix successes and failures. */
function scriptedMcp(results) {
  const calls = [];
  return {
    calls,
    tools: [
      { name: 'malloy_executeQuery', description: 'run', parameters: { type: 'object' } },
      { name: 'malloy_getContext', description: 'discover', parameters: { type: 'object' } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return results[calls.length - 1] ?? { text: 'ok', isError: false };
    },
  };
}

/** A fake Responses API that plays a script of tool calls, one array per turn,
 *  then answers in prose. */
function scriptedClient(turns, answer = 'Done.') {
  const requests = [];
  const events = (list) => ({ [Symbol.asyncIterator]: async function* () { yield* list; } });
  return {
    requests,
    responses: {
      create: async (req) => {
        requests.push(req);
        const id = `resp_${requests.length}`;
        const calls = turns[requests.length - 1];
        if (!calls) {
          return events([
            { type: 'response.output_text.delta', delta: answer },
            { type: 'response.completed', response: { id, output: [] } },
          ]);
        }
        return events([
          {
            type: 'response.completed',
            response: {
              id,
              output: calls.map((c, i) => ({
                type: 'function_call',
                name: c.name,
                call_id: `call_${requests.length}_${i}`,
                arguments: JSON.stringify(c.args),
              })),
            },
          },
        ]);
      },
    },
  };
}

/** A fake Responses API. Records every request, and replies with a tool call
 *  forever — the pathological case — unless the request disabled tools, in
 *  which case it answers in prose. */
function fakeClient(answer = 'Yes — 2.3x the baseline.') {
  const requests = [];
  const events = (list) => ({ [Symbol.asyncIterator]: async function* () { yield* list; } });
  return {
    requests,
    responses: {
      create: async (req) => {
        requests.push(req);
        const id = `resp_${requests.length}`;
        if (req.tool_choice === 'none') {
          return events([
            { type: 'response.output_text.delta', delta: answer },
            { type: 'response.completed', response: { id, output: [] } },
          ]);
        }
        return events([
          {
            type: 'response.completed',
            response: {
              id,
              output: [
                {
                  type: 'function_call',
                  name: 'malloy_executeQuery',
                  call_id: `call_${requests.length}`,
                  arguments: JSON.stringify({ query: 'run: stories -> { aggregate: c is count() }' }),
                },
              ],
            },
          },
        ]);
      },
    },
  };
}

test('a model that never stops calling tools still answers in prose', async () => {
  const client = fakeClient();
  const out = await streamChat({ mcp, history: [], userText: 'q', on: {}, client });

  assert.equal(out.answer, 'Yes — 2.3x the baseline.');
  assert.equal(client.requests.length, MAX_TURNS);
  // Tools stay on for every turn but the last, which is reserved for the answer.
  assert.equal(client.requests.at(-1).tool_choice, 'none');
  assert.ok(client.requests.slice(0, -1).every((r) => r.tool_choice !== 'none'));
  // The turn budget is spent on real work, not on the reserved answer turn.
  assert.equal(out.steps.at(-1).detail, 'run: stories -> { aggregate: c is count() }');
});

// The tool payload is not a render payload. Publisher's malloy_executeQuery
// returns flat rows for the model to read, not the malloy-interfaces Result
// (schema + data cells) that @malloydata/render needs, and it carries no SQL.
// Sniffing the payload for a renderable shape is what broke silently when that
// output changed, so the chart is fed from REST and the agent reports only the
// query it ran.
test('the render payload is not taken from the tool response', async () => {
  const client = fakeClient();
  const out = await streamChat({ mcp, history: [], userText: 'q', on: {}, client });

  const ran = out.steps.filter((s) => s.kind === 'query');
  assert.equal(ran.at(-1).detail, 'run: stories -> { aggregate: c is count() }');
  assert.ok(ran.every((s) => s.data === undefined && s.rows === undefined));
});

// "Under the hood" is supposed to show how the answer was built, so the agent
// reports the whole chain — not just the query it happened to finish on.
test('the returned trace records every tool call in order, with what it asked for', async () => {
  const client = scriptedClient([
    [
      { name: 'malloy_getContext', args: { query: 'story scores by hour', sourceName: 'stories' } },
      { name: 'malloy_executeQuery', args: { query: 'run: stories -> score_by_hour' } },
    ],
    [{ name: 'malloy_executeQuery', args: { sourceName: 'stories', queryName: 'by_category' } }],
  ]);
  const out = await streamChat({ mcp: scriptedMcp([]), history: [], userText: 'q', on: {}, client });

  assert.deepEqual(
    out.steps.map((s) => [s.kind, s.detail, s.argument, s.ok]),
    [
      ['tool', 'malloy_getContext', 'story scores by hour', true],
      ['query', 'run: stories -> score_by_hour', undefined, true],
      ['query', 'run: stories -> by_category', undefined, true],
    ]
  );
});

test('a query that errored stays in the trace, marked as failed', async () => {
  const client = scriptedClient([
    [{ name: 'malloy_executeQuery', args: { query: 'run: stories -> nope' } }],
    [{ name: 'malloy_executeQuery', args: { query: 'run: stories -> by_category' } }],
  ]);
  const mcp = scriptedMcp([{ text: 'unknown view "nope"', isError: true }]);
  const out = await streamChat({ mcp, history: [], userText: 'q', on: {}, client });

  assert.deepEqual(
    out.steps.map((s) => [s.detail, s.ok]),
    [
      ['run: stories -> nope', false],
      ['run: stories -> by_category', true],
    ]
  );
});

test('the reserved turn is skipped when the model answers on its own', async () => {
  const client = fakeClient();
  client.responses.create = async (req) => {
    client.requests.push(req);
    return {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'response.output_text.delta', delta: 'Done.' };
        yield { type: 'response.completed', response: { id: 'resp_1', output: [] } };
      },
    };
  };
  const out = await streamChat({ mcp, history: [], userText: 'q', on: {}, client });

  assert.equal(out.answer, 'Done.');
  assert.equal(client.requests.length, 1);
});
