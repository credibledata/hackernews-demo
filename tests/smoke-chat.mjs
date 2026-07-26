// Live end-to-end smoke test for the chat backend. Needs a running stack and an
// OPENAI_API_KEY (the backend process must have the key). Not part of
// `npm test` (which is hermetic) — run it against a live server:
//
//   # Docker:  OPENAI_API_KEY=sk-... docker compose up --build
//   HN_CHAT_URL=http://localhost:8080/chat/message node tests/smoke-chat.mjs
//
//   # Local dev (backend on :8787):
//   node tests/smoke-chat.mjs
//
// Asserts the agent streams an answer and returns the Malloy query + SQL behind
// it. Exits non-zero on failure.

const url = process.env.HN_CHAT_URL || 'http://127.0.0.1:8787/chat/message';
const question = process.argv[2] || 'Which domains get the highest average score? Give the top three.';

function parseSse(chunk, buffer, onEvent) {
  buffer.value += chunk;
  let sep;
  while ((sep = buffer.value.indexOf('\n\n')) !== -1) {
    const frame = buffer.value.slice(0, sep);
    buffer.value = buffer.value.slice(sep + 2);
    let event = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length) {
      let payload = {};
      try {
        payload = JSON.parse(data.join('\n'));
      } catch {
        /* ignore */
      }
      onEvent(event, payload);
    }
  }
}

const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

console.log(`→ POST ${url}`);
console.log(`  Q: ${question}\n`);

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: question }),
}).catch((e) => fail(`request failed: ${e.message}`));

if (!res.ok || !res.body) fail(`bad response: ${res.status}`);

let answer = '';
let result = null;
let errored = null;
const buffer = { value: '' };
const reader = res.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  parseSse(decoder.decode(value, { stream: true }), buffer, (event, payload) => {
    if (event === 'token') {
      answer += payload.text || '';
      process.stdout.write(payload.text || '');
    } else if (event === 'status') {
      console.log(`\n  · ${payload.kind}: ${String(payload.detail).slice(0, 80)}…`);
    } else if (event === 'result') {
      result = payload;
    } else if (event === 'error') {
      errored = payload.message;
    }
  });
}

console.log('\n');
if (errored) fail(`backend error: ${errored}`);
if (!answer.trim()) fail('no answer text streamed');
if (!result) fail('no result event (agent never ran a query)');
if (!result.malloyQuery) fail('result had no Malloy query');

console.log('✓ answer streamed');
console.log('✓ Malloy query captured:');
console.log('    ' + result.malloyQuery.replace(/\n/g, '\n    '));
console.log(result.sql ? '✓ generated SQL present' : '⚠ no SQL (result carried none)');
console.log(result.data ? '✓ renderable result present' : '⚠ no result data');
console.log('\nSmoke test passed.');
