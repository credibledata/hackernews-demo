// Syntax-highlighted source block. Shared by the "under the hood" panel, which
// shows the query that ran, and the model panel, which shows the model it ran
// against — one highlighter so the two never render Malloy differently.

import { tokenize } from './highlight';

export function Code({ code, lang }: { code: string; lang: 'malloy' | 'sql' }) {
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
