// Copy-to-clipboard button with transient confirmation. Shared by the
// under-the-hood panel, the MCP connect snippets and the answer actions.

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Confirmation for the icon form, where "✓ Copied" has nowhere to go. */
const CheckIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function CopyButton({
  text,
  label = 'Copy',
  icon,
  className = 'copy-btn',
  ariaLabel = `${label} to clipboard`,
}: {
  text: string;
  label?: string;
  /** Render as an icon button instead of a text one; `ariaLabel` names it. */
  icon?: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount avoids setting state on a button that's already gone
  // (the panel unmounts when a new chat is started).
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <button
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked (insecure origin) — leave the label alone */
        }
      }}
      aria-label={ariaLabel}
      title={icon ? ariaLabel : undefined}
      data-copied={done || undefined} // the icon form has no text to assert on
    >
      {icon ? (done ? CheckIcon : icon) : done ? '✓ Copied' : label}
    </button>
  );
}
