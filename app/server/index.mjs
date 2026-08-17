// Chat backend HTTP server.
//
//   POST /chat/message    { message, history? } -> SSE stream of the answer
//   GET  /chat/health      readiness probe
//   GET  /chat/dataset     the slice the questions run against
//   GET  /chat/model       the Malloy model source, for the "How this works" panel
//
// SSE event kinds:
//   token   { text }                     incremental answer text
//   status  { kind, detail }             "querying"/"thinking" indicators
//   result  { malloyQuery, sql, data, steps, primary }
//                                        the work behind the answer: every step
//                                        the agent took, and the one the answer
//                                        rests on (repeated at the top level)
//   done    { }                          end of turn
//   error   { message }

import './env.mjs'; // must be first: loads .env before other modules evaluate
import express from 'express';
import { config } from './config.mjs';
import { connectMcp } from './mcp.mjs';
import { streamChat } from './agent.mjs';
import { buildTrace } from './trace.mjs';
import { getDataset } from './dataset.mjs';
import { getModelSource } from './model.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { createMetrics } from './metrics.mjs';
import { createAnswerCache } from './answercache.mjs';

const app = express();
app.use(express.json({ limit: '1mb' }));
// Trust only the loopback hop (nginx). Express then walks X-Forwarded-For from
// the right and takes the first untrusted address — which is the entry nginx
// appended, i.e. the real peer. Trusting every hop instead would let a client
// spoof the header and get a fresh rate-limit bucket per request.
app.set('trust proxy', 'loopback');

// Admission control — every accepted message costs a model turn plus tool
// round-trips, so both a per-client rate and total concurrency are bounded.
const limiter = createRateLimiter({
  capacity: Number(process.env.HN_RATE_BURST || 5),
  refillPerSec: Number(process.env.HN_RATE_PER_SEC || 0.2), // ~12/min sustained
  maxInFlight: Number(process.env.HN_MAX_INFLIGHT || 8),
});

const metrics = createMetrics();

// A handful of questions dominate this demo's traffic: the starter chips and
// whatever ?q= link gets shared. Caching their answers turns "cost per visitor"
// into "cost per distinct question".
const answers = createAnswerCache({
  ttlMs: Number(process.env.HN_ANSWER_TTL_MS || 60 * 60 * 1000),
  maxEntries: Number(process.env.HN_ANSWER_CACHE_SIZE || 200),
});

/** Replay a cached turn as the same SSE sequence a live one produces, so the
 *  client needs no special case. Text goes out in chunks rather than one blob
 *  to keep the answer readable as it lands. The whole trace is stored, so a
 *  replayed answer shows the same work the live run did. */
function replayCached(send, { answer, ...result }) {
  const CHUNK = 60;
  for (let i = 0; i < answer.length; i += CHUNK) {
    send('token', { text: answer.slice(i, i + CHUNK) });
  }
  send('result', { ...result, cached: true });
  send('done', { answer });
}

// Bound the replayed history: it is resent on every turn, so an unbounded
// thread grows cost and latency without improving the answer.
const MAX_HISTORY_TURNS = Number(process.env.HN_MAX_HISTORY || 10);
const MAX_HISTORY_CHARS = 4000;

// One long-lived MCP connection, lazily established and reused.
let mcpPromise = null;
const getMcp = () => {
  if (!mcpPromise) {
    mcpPromise = connectMcp().catch((error) => {
      // Publisher may still be starting, or may restart after a data reload.
      // Do not pin that transient failure for the lifetime of this process.
      mcpPromise = null;
      throw error;
    });
  }
  return mcpPromise;
};

app.get('/chat/health', async (_req, res) => {
  try {
    await getMcp();
    res.json({ ok: true, model: config.model });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e?.message || e) });
  }
});

// Counters and answer latency. Cheap enough to hit repeatedly — everything is
// in-process, so this is just a serialisation of already-computed numbers.
// Public by default — the numbers are innocuous and useful during a spike. Set
// HN_METRICS_TOKEN to require `?token=` if you'd rather not publish your error
// rate alongside the demo.
const METRICS_TOKEN = process.env.HN_METRICS_TOKEN || '';
app.get('/chat/metrics', (req, res) => {
  if (METRICS_TOKEN && req.query.token !== METRICS_TOKEN) {
    return res.status(404).end();
  }
  res.json({ model: config.model, ...metrics.snapshot(), answer_cache: answers.stats() });
});

// The scope of the slice the questions run against, for the note on the empty
// state. Built at startup and cached, so this is a fast read.
app.get('/chat/dataset', async (_req, res) => {
  try {
    res.json({ dataset: await getDataset() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// The model source behind "How this works". Fetched only when the reader opens
// the panel, so it stays off the critical path of a page load.
app.get('/chat/model', async (_req, res) => {
  try {
    res.json({ text: await getModelSource() });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/chat/message', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  const MAX_MESSAGE_CHARS = Number(process.env.HN_MAX_MESSAGE_CHARS || 4000);
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(413).json({ error: `message must be ${MAX_MESSAGE_CHARS} characters or fewer` });
  }

  const grant = limiter.acquire(req.ip || 'unknown');
  if (!grant.ok) {
    metrics.limited(grant.reason);
    res.set('Retry-After', String(grant.retryAfterSec));
    return res.status(429).json({ error: grant.reason, retryAfterSec: grant.retryAfterSec });
  }

  metrics.started();
  const startedAt = Date.now();
  // Anything that isn't an explicit success or error is an abandoned request.
  let outcome = 'aborted';

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // A client that navigates away (or hits Stop) must not leave an agent loop
  // running to completion — that is billed work nobody will ever see.
  // Listen on `res`, not `req`: the request stream closes as soon as its body
  // has been read, which is long before the client goes away. The response
  // closing while we still have writes pending is the real disconnect signal.
  const ac = new AbortController();
  let closedEarly = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      closedEarly = true;
      ac.abort();
    }
  });

  // Trim the replayed history to the most recent turns, each capped in size.
  const trimmed = (Array.isArray(history) ? history : [])
    .slice(-MAX_HISTORY_TURNS)
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));

  // Only opening questions are cacheable — a follow-up's answer depends on the
  // conversation before it, so replaying one out of context would be wrong.
  const cacheable = trimmed.length === 0;

  try {
    const cached = cacheable ? answers.get(message) : null;
    if (cached) {
      replayCached(send, cached);
      outcome = 'cached';
      return; // finally still records the outcome and closes the stream
    }

    const mcp = await getMcp();
    // The status events are the live progress line; the trace the agent returns
    // is what the panel is built from once the answer is done.
    const { answer, steps, aborted } = await streamChat({
      mcp,
      history: trimmed,
      userText: message,
      signal: ac.signal,
      on: {
        text: (text) => send('token', { text }),
        query: (q) => send('status', { kind: 'querying', detail: q }),
        tool: (name) => send('status', { kind: 'tool', detail: name }),
      },
    });

    if (!aborted && !closedEarly) {
      // Fill the panel: every step the agent took, with its queries re-run over
      // REST for the SQL and rows the browser renders.
      const trace = await buildTrace(steps);
      const lead = trace.steps[trace.primary];
      let result = null;
      if (lead) {
        // The lead result is repeated at the top level: it feeds the chart, the
        // CSV download and the interpretation line, none of which should have to
        // know about the trace.
        result = {
          malloyQuery: lead.detail,
          sql: lead.sql,
          data: lead.data,
          interpretation: lead.interpretation,
          steps: trace.steps,
          primary: trace.primary,
        };
        send('result', result);
      }

      // A turn that produced no prose is a failure, not a terse answer. Report
      // it as one: sent as `done`, the client would render the last query's
      // table alone, which reads as a numeric non-answer to a real question.
      if (!answer) {
        send('error', {
          message: 'The analyst ran out of steps before it could answer. Try again, or ask something narrower.',
        });
        outcome = 'error';
      } else {
        send('done', { answer });
        outcome = 'completed';

        // Cache only a complete, grounded answer: one that finished and actually
        // ran a query. A prose-only reply has nothing to show under the hood.
        if (cacheable && result) {
          answers.set(message, { answer, ...result });
        }
      }
    }
  } catch (e) {
    // An abort is the expected path when the user stops or leaves, not an error.
    if (!closedEarly && e?.name !== 'AbortError') {
      console.error('[chat] error', e);
      send('error', { message: String(e?.message || e) });
      outcome = 'error';
    }
  } finally {
    // Recorded once, here, so every path out of the handler balances the
    // in-flight gauge — including the ones that never reach the catch.
    const ms = Date.now() - startedAt;
    if (outcome === 'completed') metrics.completed(ms);
    else if (outcome === 'cached') metrics.servedFromCache();
    else if (outcome === 'error') metrics.errored();
    else metrics.abortedRequest();

    grant.release();
    res.end();
  }
});

app.listen(config.port, () => {
  console.log(`[chat] backend listening on :${config.port}`);
  console.log(`[chat] MCP -> ${config.mcpUrl}  REST -> ${config.restUrl}  model ${config.model}`);
  // Read the slice's scope at boot, not on the first page load, so the note on
  // the empty state is there when the first visitor arrives.
  getDataset()
    .then((ds) =>
      console.log(
        ds
          ? `[chat] dataset ready: ${ds.stories} stories ${ds.from.slice(0, 10)}..${ds.to.slice(0, 10)}`
          : '[chat] no dataset info'
      )
    )
    .catch(() => {});
});
