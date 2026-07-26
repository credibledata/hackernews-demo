// The analyst agent: drives an OpenAI model via the Responses API in a streaming
// tool loop over the Publisher MCP tools. The Responses API is used (rather than
// chat.completions) because the newer reasoning models require it to combine
// reasoning with function tools. Emits text deltas and tool-call notifications
// through callbacks, and records the Malloy query the model ran so the caller can
// show it (and its compiled SQL) in the UI.

import OpenAI from 'openai';
import { config } from './config.mjs';

// Constructed on first use (it reads OPENAI_API_KEY at construction), so the
// module can be imported by a test that injects its own client.
let openai;
const defaultClient = () => (openai ??= new OpenAI());

const SYSTEM = `You are a Hacker News data analyst. Answer questions ONLY from the
governed Malloy semantic model, through the Publisher MCP tools — never guess
numbers, and never write Malloy from memory without grounding it in the model.

Use the tools extensively. A good turn uses several tool calls before answering:

1. DISCOVER — always start by calling malloy_getContext with a short
   natural-language description of what you need. It returns the model's real
   sources, named views, dimensions, and measures, each with a doc string. Call it
   again (with a different phrasing, or a specific sourceName) if you need more of
   the model. Use the EXACT names it returns — do not invent field or view names.

2. LEARN SYNTAX when writing anything custom — call malloy_searchDocs to look up
   Malloy syntax (functions, group_by/aggregate, filters, time). Don't guess
   syntax; confirm it.

3. PREFER NAMED VIEWS — they are pre-built and always valid:
       run: <sourceName> -> <viewName>
   e.g.  run: stories -> top_domains
   (The "<sourceName> ->" part is required; "run: top_domains" alone is invalid.)
   The sources are "stories" and "comments"; getContext lists each source's views.

4. VALIDATE NEW QUERY SHAPES — when no view fits and you must write custom
   Malloy, call malloy_compile with the query as "source" to check it, then fix
   any errors it reports. Compile a shape once: once one has compiled clean, run
   later variants of it (different filters, limits, field lists) straight through
   malloy_executeQuery, and only compile again if a run actually fails. Form:
       run: <sourceName> -> { group_by: <dimension>; aggregate: <name> is <measure>; order_by: <name> desc; limit: N }
   Use the measures/dimensions getContext listed (e.g. avg_score, story_count).
   Aggregate functions are avg(), sum(), count(), min(), max() — never average().

5. COMPARE IN ONE QUERY — when the question contrasts groups ("GPT vs Claude",
   "Ask HN vs Show HN", by year), write ONE query whose group_by labels each
   group, so every group is a row in the same result:
       run: stories -> {
         group_by: model is
           pick 'GPT' when title ~ '%GPT%'
           pick 'Claude' when title ~ '%Claude%'
           else null
         aggregate: avg_score, max_score, story_count
         where: title ~ '%GPT%' or title ~ '%Claude%'
       }
   Never run one filtered query per group. Only the last query you run is shown
   to the user, so N queries means N-1 groups vanish and the survivor arrives
   with no label saying which group it is. A grouped query is also the more
   correct answer: overlapping members (a title naming both) land in exactly one
   bucket instead of being counted twice.

6. RUN — call malloy_executeQuery. Always pass a full "query" string (not a
   queryName) so the query is visible to the user.

7. ANSWER — in prose. Lead with the direct answer and key numbers, then one short
   supporting sentence. Be concise; do not restate the query or narrate tool use.
   A comparison ("unusually high?", "more than X?") needs its baseline in the
   answer, not just the filtered number.

You have a budget of about 15 tool calls per question. Spend it on queries:
don't repeat a discovery or docs call that you already have the answer to.

The data is a bounded, recent slice of Hacker News. Times are UTC; scores are
point-in-time snapshots.`;

// Turns the model may take per question. The last one is reserved: tools are
// switched off so it has to answer. Without that a model still working when the
// budget ran out returned no text at all, and the UI drew the last query's
// table with nothing above it.
export const MAX_TURNS = 20;

const OUT_OF_BUDGET = `Your tool budget is spent. Answer now, in prose, from the
results you already have. If they don't settle the question, say plainly what is
still missing rather than guessing.`;

// MCP tools → Responses API function tools (flat shape: name at top level).
const toResponsesTools = (tools) =>
  tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

/** Pull the renderable Malloy result out of an executeQuery tool response.
 *  Publisher returns the malloy-interfaces Result verbatim (schema + data +
 *  the compiled sql), which is exactly what the chart and the SQL panel need —
 *  so there is no reason to run the query a second time over REST. */
function parseQueryResult(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.schema && parsed?.data ? parsed : null;
  } catch {
    return null;
  }
}

export async function streamChat({ mcp, history, userText, on, signal, client = defaultClient() }) {
  const tools = toResponsesTools(mcp.tools);
  let lastQuery = null;
  let lastResult = null;

  // First request carries the conversation; subsequent tool round-trips chain
  // off previous_response_id and send only the tool outputs.
  let input = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];
  let previousResponseId;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (signal?.aborted) return { answer: '', lastQuery, lastResult, aborted: true };
    // On the final turn, take the tools away and ask for the answer, so the
    // loop can only ever end in prose.
    const finalTurn = turn === MAX_TURNS - 1;
    if (finalTurn) input.push({ role: 'user', content: OUT_OF_BUDGET });
    const stream = await client.responses.create(
      {
        model: config.model,
        instructions: SYSTEM,
        input,
        previous_response_id: previousResponseId,
        tools,
        tool_choice: finalTurn ? 'none' : 'auto',
        max_output_tokens: config.maxTokens,
        stream: true,
      },
      { signal }
    );

    let text = '';
    let final = null;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        text += event.delta;
        on.text?.(event.delta);
      } else if (event.type === 'response.completed') {
        final = event.response;
      } else if (event.type === 'response.failed' || event.type === 'error') {
        throw new Error(event.response?.error?.message || 'model response failed');
      }
    }
    if (!final) throw new Error('no completed response');
    previousResponseId = final.id;

    const calls = (final.output || []).filter((o) => o.type === 'function_call');
    if (calls.length === 0) {
      return { answer: text, lastQuery, lastResult };
    }

    // Execute each tool call and feed the outputs back on the next turn.
    input = [];
    for (const call of calls) {
      if (signal?.aborted) return { answer: text, lastQuery, lastResult, aborted: true };
      let args = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        /* leave empty; tool will error informatively */
      }
      const queryStr =
        call.name === 'malloy_executeQuery'
          ? typeof args.query === 'string'
            ? args.query
            : args.sourceName && args.queryName
              ? `run: ${args.sourceName} -> ${args.queryName}`
              : null
          : null;
      if (queryStr) on.query?.(queryStr);
      else on.tool?.(call.name);

      const result = await mcp.callTool(call.name, args);
      console.error(
        `[tool] ${call.name} args=${JSON.stringify(args).slice(0, 200)} -> ${result.text.length} chars${result.isError ? ' (ERROR)' : ''}`
      );
      // Only surface a query in the UI if it actually ran, so a trailing failed
      // attempt doesn't populate the panel with a broken query. Keep its result
      // payload too — it already carries the schema, rows, and compiled SQL.
      if (queryStr && !result.isError) {
        lastQuery = queryStr;
        lastResult = parseQueryResult(result.text) ?? lastResult;
      }

      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: result.text || '(no output)',
      });
    }
  }

  return { answer: '', lastQuery, lastResult };
}
