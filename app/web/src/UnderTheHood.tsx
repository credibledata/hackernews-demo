// The card that carries the work behind an answer. It leads with what the
// numbers mean — the deterministic gloss from the server — and opens onto how
// they were reached: every step the agent took, and for each query it ran, the
// Malloy, the SQL it compiled to, and the rows that came back. Claim and proof
// live in one card because separately they read as two unrelated footers. This
// is the demo's whole credibility argument, so it's a first-class tabbed view
// rather than a dump.

import { useEffect, useState } from 'react';
import type { Step } from './api';
import { Code } from './Code';
import { CopyButton } from './CopyButton';
import { DataTable, downloadCsv, rowsOf, toCsv } from './resultView';

// Set at build time (VITE_EXPLORER_URL) when a Publisher Explorer is exposed
// separately. Left unset in the default single-port deploy, where Explorer's
// absolute asset paths collide with this app's.
const EXPLORER_URL = (import.meta.env.VITE_EXPLORER_URL as string | undefined) || '';

// Tool names are an implementation detail; the trace should read as what the
// agent actually did.
const STEP_LABELS: Record<string, string> = {
  malloy_getContext: 'Discovered the model’s sources and fields',
  malloy_searchDocs: 'Looked up Malloy syntax',
  malloy_compile: 'Validated the query before running it',
  malloy_executeQuery: 'Ran a Malloy query',
};

/** How a step reads in the trace and in the live status line. */
export const stepLabel = (kind: string, detail: string) =>
  kind === 'query' || kind === 'querying'
    ? STEP_LABELS.malloy_executeQuery
    : STEP_LABELS[detail] || detail;

type Props = {
  steps: Step[];
  primary: number;
  cached?: boolean;
};

export function UnderTheHood({ steps, primary, cached }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'malloy' | 'sql' | 'data'>('malloy');
  // Which step's work is on show. Starts on the result the answer rests on; a
  // later `result` event (a retry, a cached replay) re-pins it there.
  const [selected, setSelected] = useState(primary);
  useEffect(() => setSelected(primary), [primary, steps]);

  const step = steps[selected] ?? steps[primary];
  if (!step) return null;

  // What the numbers mean, for the query on show. Every step that returned data
  // carries its own gloss, and only those steps are selectable, so the fallback
  // is defensive. Keeping it on the selected step is the point: the claim and
  // the query proving it are never about different rows.
  const interpretation = step.interpretation ?? steps[primary]?.interpretation;

  // The result payload is opaque to this component — it only counts rows and
  // hands it to the table/CSV readers, which know its shape.
  const data = step.data as any;
  const rowCount = rowsOf(data).length;
  const tabs = [
    { id: 'malloy' as const, label: 'Malloy', show: true },
    { id: 'sql' as const, label: 'SQL', show: !!step.sql },
    { id: 'data' as const, label: rowCount ? `Data (${rowCount})` : 'Data', show: !!data },
  ].filter((t) => t.show);
  // A step with no rows can't show the tab that was open on a step that had them.
  const active = tabs.some((t) => t.id === tab) ? tab : 'malloy';

  return (
    <div className={`hood ${open ? 'open' : ''}`}>
      {interpretation && (
        <div className="interpretation" aria-live="polite">
          <b>Interpreted as:</b> {interpretation}.
        </div>
      )}
      <button className="hood-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="hood-caret" aria-hidden="true">
          ▸
        </span>
        How this was computed
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
          <ol className="hood-steps">
            {steps.map((s, i) => {
              const label = stepLabel(s.kind, s.detail);
              const note = s.kind === 'query' ? s.detail : s.argument;
              const body = (
                <>
                  <span className="step-label">
                    {label}
                    {!s.ok && <span className="step-flag"> failed</span>}
                    {s.rows !== undefined && (
                      <span className="step-rows">
                        {s.rows} row{s.rows === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                  {note && <code className="step-note">{note}</code>}
                </>
              );
              // Only a step that produced something has anything to select.
              return (
                <li key={i} className={`${s.ok ? '' : 'failed'} ${i === selected ? 'active' : ''}`}>
                  {s.data ? (
                    <button className="hood-step" onClick={() => setSelected(i)} aria-pressed={i === selected}>
                      {body}
                    </button>
                  ) : (
                    <div className="hood-step">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
          {cached && (
            <p className="hood-note hood-cached-note">
              This exact question was asked before, so the saved answer and its queries were
              replayed instead of running the agent again.
            </p>
          )}

          <div className="hood-tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={active === t.id}
                className={`hood-tab ${active === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
            <div className="hood-actions">
              {active === 'malloy' && <CopyButton text={step.detail} />}
              {active === 'sql' && step.sql && <CopyButton text={step.sql} />}
              {active === 'data' && data && (
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
                  href={`${EXPLORER_URL}?query=${encodeURIComponent(step.detail)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Explorer ↗
                </a>
              )}
            </div>
          </div>

          {active === 'malloy' && <Code code={step.detail} lang="malloy" />}
          {active === 'sql' && step.sql && <Code code={step.sql} lang="sql" />}
          {active === 'data' && data && <DataTable data={data} />}
        </div>
      )}
    </div>
  );
}
