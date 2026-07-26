// The panel that shows the work behind an answer: the Malloy the agent ran, the
// SQL it compiled to, and the rows that came back. This is the demo's whole
// credibility argument, so it's a first-class tabbed view rather than a dump.

import { useState } from 'react';
import { tokenize } from './highlight';
import { CopyButton } from './CopyButton';
import { DataTable, downloadCsv, rowsOf, toCsv } from './resultView';

// Set at build time (VITE_EXPLORER_URL) when a Publisher Explorer is exposed
// separately. Left unset in the default single-port deploy, where Explorer's
// absolute asset paths collide with this app's.
const EXPLORER_URL = (import.meta.env.VITE_EXPLORER_URL as string | undefined) || '';

type Props = {
  malloyQuery: string;
  sql: string | null;
  data: any | null;
  steps: string[];
  cached?: boolean;
};

function Code({ code, lang }: { code: string; lang: 'malloy' | 'sql' }) {
  return (
    <pre className="code">
      <code>
        {tokenize(code, lang).map((t, i) =>
          t.cls ? (
            <span key={i} className={`tok-${t.cls}`}>
              {t.text}
            </span>
          ) : (
            t.text
          )
        )}
      </code>
    </pre>
  );
}

export function UnderTheHood({ malloyQuery, sql, data, steps, cached }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'malloy' | 'sql' | 'data'>('malloy');

  const rowCount = rowsOf(data).length;
  const tabs = [
    { id: 'malloy' as const, label: 'Malloy', show: true },
    { id: 'sql' as const, label: 'SQL', show: !!sql },
    { id: 'data' as const, label: rowCount ? `Data (${rowCount})` : 'Data', show: !!data },
  ].filter((t) => t.show);

  return (
    <div className={`hood ${open ? 'open' : ''}`}>
      <button className="hood-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="hood-caret" aria-hidden="true">
          ▸
        </span>
        Under the hood
        {steps.length > 0 && (
          <span className="hood-summary">
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </span>
        )}
        {cached && (
          <span className="hood-badge" title="Replayed from a previous run of this exact question">
            cached
          </span>
        )}
      </button>

      {open && (
        <div className="hood-body">
          {steps.length > 0 && (
            <ol className="hood-steps">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          )}
          {cached && (
            <p className="hood-note hood-cached-note">
              This exact question was asked before, so the saved answer and its query were
              replayed instead of running the agent again.
            </p>
          )}

          <div className="hood-tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={`hood-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
            <div className="hood-actions">
              {tab === 'malloy' && <CopyButton text={malloyQuery} />}
              {tab === 'sql' && sql && <CopyButton text={sql} />}
              {tab === 'data' && data && (
                <>
                  <CopyButton text={toCsv(data)} label="Copy CSV" />
                  <button className="copy-btn" onClick={() => downloadCsv(data)}>
                    Download
                  </button>
                </>
              )}
              {EXPLORER_URL && (
                <a
                  className="copy-btn"
                  href={`${EXPLORER_URL}?query=${encodeURIComponent(malloyQuery)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Explorer ↗
                </a>
              )}
            </div>
          </div>

          {tab === 'malloy' && <Code code={malloyQuery} lang="malloy" />}
          {tab === 'sql' && sql && <Code code={sql} lang="sql" />}
          {tab === 'data' && data && <DataTable data={data} />}
        </div>
      )}
    </div>
  );
}
