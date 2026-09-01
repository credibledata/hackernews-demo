// Dev-only harness (open with ?check) to validate that MalloyChart renders a
// real Publisher result — the same render path the chat answers use. No API key
// needed; it fetches a known query straight from Publisher REST.
import { useEffect, useState } from 'react';
import { MalloyChart } from './MalloyChart';
import { appUrl } from './appUrl';

const QUERIES = [
  'run: stories -> by_category',
  'run: stories -> score_by_hour',
  'run: comments -> avg_length_by_category',
];

export function RenderCheck() {
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        for (const q of QUERIES) {
          const r = await fetch(
            appUrl('/api/v0/environments/hn/packages/hacker-news/models/hn.malloy/query'),
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) }
          );
          const j = await r.json();
          setResults((prev) => ({ ...prev, [q]: JSON.parse(j.result) }));
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 820, margin: '0 auto' }}>
      <h2>MalloyChart render check</h2>
      {err && <div style={{ color: 'red' }}>Error: {err}</div>}
      {QUERIES.map((q) => (
        <div key={q} style={{ margin: '20px 0', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{q}</div>
          {results[q] ? <MalloyChart result={results[q]} /> : <div>loading…</div>}
        </div>
      ))}
    </div>
  );
}
