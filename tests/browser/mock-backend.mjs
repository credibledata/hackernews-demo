// Stand-in for the chat backend, so the browser tests are hermetic: no API key,
// no Publisher, no DuckDB, and — crucially — deterministic timing, which is what
// makes the scroll assertions reliable.
//
// Speaks the same SSE contract as app/server/index.mjs:
//   status -> token* -> result -> done
//
// Run standalone:  node tests/browser/mock-backend.mjs [port]

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8787);

const SUGGESTIONS = [
  'Which domains get the highest average score?',
  'What are the best hours to post for a high score?',
  'How has Ask HN vs Show HN volume changed over time?',
  'Who are the most active commenters?',
];

const DATASET = {
  stories: 18465,
  comments: 92113,
  from: '2012-06-01T00:01:25.000Z',
  to: '2012-06-30T23:59:22.000Z',
};

// Long enough to overflow the viewport, so scroll behaviour is observable.
const PARAGRAPH =
  'The ranking is computed from the governed Malloy model rather than ad-hoc SQL, ' +
  'so the numbers are consistent with every other view over the same source. ';

const answerText = (long) =>
  long ? `Here is a detailed breakdown.\n\n${PARAGRAPH.repeat(24)}` : `Short answer. ${PARAGRAPH}`;

// Mirrors the malloy-interfaces Result the real Publisher returns, so the chart,
// the Data tab and the CSV export all exercise real code paths.
const RESULT = {
  schema: {
    fields: [
      { kind: 'dimension', name: 'category', type: { kind: 'string_type' } },
      { kind: 'dimension', name: 'story_count', type: { kind: 'number_type', subtype: 'integer' } },
    ],
  },
  data: {
    kind: 'array_cell',
    array_value: [
      { kind: 'record_cell', record_value: [{ kind: 'string_cell', string_value: 'Link' }, { kind: 'number_cell', number_value: 17342 }] },
      { kind: 'record_cell', record_value: [{ kind: 'string_cell', string_value: 'Ask HN' }, { kind: 'number_cell', number_value: 1204 }] },
      { kind: 'record_cell', record_value: [{ kind: 'string_cell', string_value: 'Show HN' }, { kind: 'number_cell', number_value: 831 }] },
    ],
  },
  connection_name: 'duckdb',
  annotations: [],
  model_annotations: [],
  sql: 'SELECT base."category", COUNT(1) FROM stories AS base GROUP BY 1',
};

// The same rows carrying the tag Publisher returns for a chart-tagged view.
// The renderer only draws a chart when the query says so, and the card keys its
// layout off that tag, so both paths need covering.
const CHART_RESULT = { ...RESULT, annotations: [{ value: '# bar_chart\n' }] };

// A wide row listing — prose, a timestamp, two numbers and two URL-ish columns.
// This is the shape that exposes column layout: left to itself the renderer
// sizes every track between its min- and max-content, so the long unbreakable
// URL claims the card and the prose title is squeezed to one word per line.
const wideRow = (title, time, score, descendants, url, domain) => ({
  kind: 'record_cell',
  record_value: [
    { kind: 'string_cell', string_value: title },
    { kind: 'timestamp_cell', timestamp_value: time },
    { kind: 'number_cell', number_value: score },
    { kind: 'number_cell', number_value: descendants },
    { kind: 'string_cell', string_value: url },
    { kind: 'string_cell', string_value: domain },
  ],
});

const WIDE_RESULT = {
  ...RESULT,
  schema: {
    fields: [
      { kind: 'dimension', name: 'title', type: { kind: 'string_type' } },
      { kind: 'dimension', name: 'time', type: { kind: 'timestamp_type' } },
      { kind: 'dimension', name: 'score', type: { kind: 'number_type', subtype: 'integer' } },
      { kind: 'dimension', name: 'descendants', type: { kind: 'number_type', subtype: 'integer' } },
      { kind: 'dimension', name: 'url', type: { kind: 'string_type' } },
      { kind: 'dimension', name: 'domain', type: { kind: 'string_type' } },
    ],
  },
  data: {
    kind: 'array_cell',
    array_value: [
      wideRow(
        'Apple decided not to roll out Siri in EU after denied request for exemption',
        '2026-06-09T16:13:10.000Z',
        85,
        153,
        'https://www.reuters.com/business/apple-failed-make-its-ai-tool-comply-eu-regulations-eu-commission-says-2026-06-09/',
        'reuters.com'
      ),
      wideRow(
        'Apple announces significant price increases for MacBooks, iPads, more',
        '2026-06-25T13:02:56.000Z',
        131,
        113,
        'https://9to5mac.com/2026/06/25/apple-price-increases-mac-ipad-more/',
        '9to5mac.com'
      ),
      wideRow(
        'Apple WWDC 2026 Livestream',
        '2026-06-08T17:14:24.000Z',
        93,
        94,
        'https://www.apple.com/apple-events/event-stream/',
        'apple.com'
      ),
    ],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/chat/health') {
    return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"model":"mock"}');
  }
  if (url.pathname === '/chat/starter') {
    return res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ suggestions: SUGGESTIONS, dataset: DATASET }));
  }
  if (url.pathname !== '/chat/message' || req.method !== 'POST') {
    return res.writeHead(404).end();
  }

  const body = await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
  const message = String(body.message || '');

  // Let a test force a 429 without needing to exhaust the real limiter.
  if (message.includes('FORCE_429')) {
    res.writeHead(429, { 'content-type': 'application/json', 'Retry-After': '7' });
    return res.end(JSON.stringify({ error: 'rate', retryAfterSec: 7 }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Stop when the client goes away, exactly like the real backend.
  let closed = false;
  res.on('close', () => (closed = true));

  send('status', { kind: 'tool', detail: 'malloy_getContext' });
  await sleep(80);
  send('status', { kind: 'querying', detail: 'run: stories -> by_category' });
  await sleep(80);

  const text = answerText(message.includes('LONG'));
  for (let i = 0; i < text.length && !closed; i += 24) {
    send('token', { text: text.slice(i, i + 24) });
    await sleep(28); // slow enough that a test can interact mid-stream
  }
  if (closed) return;

  const result = message.includes('CHART')
    ? CHART_RESULT
    : message.includes('WIDE')
      ? WIDE_RESULT
      : RESULT;
  send('result', { malloyQuery: 'run: stories -> by_category', sql: RESULT.sql, data: result });
  send('done', { answer: text });
  res.end();
});

server.listen(PORT, () => console.log(`[mock] chat backend on :${PORT}`));
