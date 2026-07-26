// "How this works" modal: a high-level explainer of the pieces behind the demo
// — the Malloy model, the Publisher server, and MCP. Copy is kept factual and
// matches the framing in the project README and the Malloy/Publisher repos.

import { useEffect, useRef } from 'react';
import { McpConnect } from './McpConnect';
import { DatasetNote } from './DatasetNote';
import type { Dataset } from './api';

const MALLOY_REPO = 'https://github.com/malloydata/malloy';
const PUBLISHER_REPO = 'https://github.com/malloydata/publisher';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function HowItWorks({
  open,
  onClose,
  dataset = null,
}: {
  open: boolean;
  onClose: () => void;
  dataset?: Dataset | null;
}) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    // Remember who opened it so focus can go back there on close, rather than
    // dumping keyboard users at the top of the document.
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab') return;

      // Trap Tab inside the dialog — otherwise focus walks into the page behind
      // the overlay, which is both invisible and unreachable by mouse.
      const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || !dialog.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="How this works"
        ref={dialog}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <h2>How this works</h2>
        <p className="modal-lead">
          You ask in plain English; an AI agent answers using a governed data model instead of
          writing raw SQL. So the numbers come back right by construction — and every answer shows
          the query behind it.
        </p>

        <div className="modal-steps">
          <section>
            <h3>
              <a href={MALLOY_REPO} target="_blank" rel="noreferrer">Malloy</a>
              <span className="modal-tag">the semantic model</span>
            </h3>
            <p>
              Malloy is an open-source language for describing data and querying it. The relationships,
              dimensions, and measures are defined once in the model — for example how a story's score
              or a comment's thread is computed — and every query reuses those definitions. Malloy
              compiles to SQL, so the model stays the single source of truth for what the numbers mean.
            </p>
          </section>

          <section>
            <h3>
              <a href={PUBLISHER_REPO} target="_blank" rel="noreferrer">Publisher</a>
              <span className="modal-tag">serves the model</span>
            </h3>
            <p>
              The Malloy Publisher hosts the model as a package and serves it three ways: a REST API, an
              interactive Explorer for building queries by hand, and an MCP server so AI agents can query
              the model directly. This demo runs against a curated slice of public Hacker News data.
            </p>
            <DatasetNote dataset={dataset} className="modal-dataset" />
          </section>

          <section>
            <h3>
              MCP
              <span className="modal-tag">how the agent connects</span>
            </h3>
            <p>
              The agent reaches the model over MCP (Model Context Protocol): it discovers the real
              sources and views, composes a Malloy query, validates it, and runs it — never inventing
              field names or numbers. You can point your own agent at the same endpoint, or expand
              “Under the hood” on any answer to see the exact Malloy query and generated SQL.
            </p>
            <McpConnect lead="Connect your own agent to the same model:" />
          </section>
        </div>
      </div>
    </div>
  );
}
