// The agent loop's turn budget. A comparative question ("is X unusually high?")
// needs several queries plus their discovery and validation calls, so a run can
// use the whole budget. What must never happen is a run that spends the budget
// and returns nothing — the UI then draws the last query's table with no answer
// above it, which reads as a numeric non-answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, MAX_TURNS } from '../app/server/agent.mjs';

/** An MCP double: every tool call succeeds with a trivial payload. */
const mcp = {
  tools: [{ name: 'malloy_executeQuery', description: 'run', parameters: { type: 'object' } }],
  callTool: async () => ({ text: '{"schema":{"fields":[]},"data":{"array_value":[]}}', isError: false }),
};

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
  assert.equal(out.lastQuery, 'run: stories -> { aggregate: c is count() }');
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
