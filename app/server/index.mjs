// Chat backend HTTP server.
//
//   POST /api/chat        { message, history? } -> SSE stream of the answer
//   GET  /api/health      readiness probe
//
// SSE event kinds:
//   token   { text }                     incremental answer text
//   status  { kind, detail }             "querying"/"thinking" indicators
//   result  { malloyQuery, sql, data }   the query behind the answer + rendering data
//   done    { }                          end of turn
//   error   { message }

import './env.mjs'; // must be first: loads .env before other modules evaluate
import express from 'express';
import { config } from './config.mjs';
import { connectMcp } from './mcp.mjs';
import { streamChat } from './agent.mjs';
import { compileSql, runQuery } from './publisher.mjs';
import { getSuggestions } from './suggestions.mjs';
import { getDataset } from './dataset.mjs';
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
 *  to keep the answer readable as it lands. */
function replayCached(send, hit) {
  for (const step of hit.steps || []) send('status', step);
  const CHUNK = 60;
  for (let i = 0; i < hit.answer.length; i += CHUNK) {
    send('token', { text: hit.answer.slice(i, i + CHUNK) });
  }
  send('result', {
    malloyQuery: hit.malloyQuery,
    sql: hit.sql,
    data: hit.data,
    cached: true,
  });
  send('done', { answer: hit.answer });
}

// Bound the replayed history: it is resent on every turn, so an unbounded
// thread grows cost and latency without improving the answer.
const MAX_HISTORY_TURNS = Number(process.env.HN_MAX_HISTORY || 10);
const MAX_HISTORY_CHARS = 4000;

// One long-lived MCP connection, lazily established and reused.
let mcpPromise = null;
const getMcp = () => (mcpPromise ??= connectMcp());

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

// Everything the empty state needs: the data-derived starter questions and the
// scope of the slice they run against. Both are built at startup and cached, so
// this is a fast read and the chips never change under a reader mid-session.
app.get('/chat/starter', async (_req, res) => {
  try {
    const [suggestions, dataset] = await Promise.all([getSuggestions(), getDataset()]);
    res.json({ suggestions, dataset });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/chat/message', async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
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

    // Each tool call is recorded so a cached replay can reproduce the same
    // "under the hood" trace the live run showed.
    const steps = [];
    const mcp = await getMcp();
    const { answer, lastQuery, lastResult, aborted } = await streamChat({
      mcp,
      history: trimmed,
      userText: message,
      signal: ac.signal,
      on: {
        text: (text) => send('token', { text }),
        query: (q) => {
          steps.push({ kind: 'querying', detail: q });
          send('status', { kind: 'querying', detail: q });
        },
        tool: (name) => {
          steps.push({ kind: 'tool', detail: name });
          send('status', { kind: 'tool', detail: name });
        },
      },
    });

    if (!aborted && !closedEarly) {
      // Populate the "under the hood" panel from the last query the model ran.
      // The MCP tool response already carries the schema, rows, and compiled
      // SQL, so reuse it — re-running the query here would double the work and
      // stall the chart behind a second round-trip. REST is only a fallback for
      // a Publisher version whose tool output omits the payload.
      let result = null;
      if (lastResult) {
        result = { malloyQuery: lastQuery, sql: lastResult.sql ?? null, data: lastResult };
      } else if (lastQuery) {
        const data = await runQuery(lastQuery);
        result = { malloyQuery: lastQuery, sql: data?.sql ?? (await compileSql(lastQuery)), data };
      }
      if (result) send('result', result);

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
          answers.set(message, { answer, steps, ...result });
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
  // Build the empty state's contents at boot, not on the first page load, so
  // the chips land as one set instead of swapping in under the reader.
  Promise.all([getSuggestions(), getDataset()])
    .then(([qs, ds]) =>
      console.log(
        `[chat] starter ready: ${qs.length} questions` +
          (ds ? `, ${ds.stories} stories ${ds.from.slice(0, 10)}..${ds.to.slice(0, 10)}` : ', no dataset info')
      )
    )
    .catch(() => {});
});
