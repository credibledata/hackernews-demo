// Renders a Malloy query result as its tagged chart/table via @malloydata/render.
// The `result` is the payload the backend fetched from Publisher (a
// malloy-interfaces Result). Falls back to a message if rendering fails.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MalloyRenderer } from '@malloydata/render';
import { fieldsOf, rowsOf } from './resultView';

const renderer = new MalloyRenderer();

// The renderer scopes its own theme variables onto the viz root, which beats
// anything we inherit from a parent rule — so the theme has to be handed to it
// explicitly. These values are `var()` references to our tokens, so a light/dark
// toggle repaints the rendered table without re-rendering the result.
const THEME = {
  background: 'transparent',
  tableBackground: 'transparent',
  tableBodyColor: 'var(--ink)',
  tableHeaderColor: 'var(--muted)',
  tableBorder: '1px solid var(--border)',
  tablePinnedBackground: 'var(--panel)',
  tablePinnedBorder: '1px solid var(--border)',
  tableGutterSize: '8px',
  fontFamily: 'inherit',
};

// The renderer lays its table out as a grid of `minmax(auto, max-content)`
// tracks, so every column's floor is its min-content and the leftover space is
// split evenly rather than by need: one long URL (min-content = its longest
// hyphen-free run) claims the card while a prose title is squeezed to a word per
// line. We compute the template ourselves instead — columns with a fixed shape
// (numbers, dates, short labels) take exactly what they need, and the long text
// columns share the rest in proportion to how much text they hold. The rule
// that applies it lives in styles.css, since the renderer writes its own
// template as an inline style.
const WRAP_CHARS = 24; // below this a column fits on one line anyway
const WEIGHT_CAP = 40; // past this, extra weight buys no extra readability

function columnTemplate(result: any): string | null {
  const fields = fieldsOf(result);
  const rows = rowsOf(result).slice(0, 100); // a sample is enough to size columns
  if (!fields.length || !rows.length) return null;

  const tracks: string[] = [];
  for (let j = 0; j < fields.length; j++) {
    const cells = rows.map((row: any) => row?.record_value?.[j]);
    // A nested field renders as a subgrid spanning several columns, so the
    // track count isn't ours to guess — leave those results to the renderer.
    if (cells.some((c: any) => c?.kind === 'array_cell' || c?.kind === 'record_cell')) return null;
    const text = cells.filter((c: any) => typeof c?.string_value === 'string');
    const mean = text.length
      ? text.reduce((n: number, c: any) => n + c.string_value.length, 0) / text.length
      : 0;
    tracks.push(
      mean > WRAP_CHARS ? `minmax(0, ${Math.min(mean, WEIGHT_CAP).toFixed(1)}fr)` : 'max-content'
    );
  }
  return tracks.join(' ');
}

export function MalloyChart({
  result,
  height = 320,
}: {
  result: unknown;
  /** Pixel height for the vega charts, which size themselves from the
   *  container. `null` lets a content-sized render (a table) be its own height. */
  height?: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const columns = useMemo(() => columnTemplate(result), [result]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !result) return;
    setError(null);
    let viz: ReturnType<typeof renderer.createViz> | null = null;
    // Render after layout so the target element has a real size — vega sizes the
    // chart from the container, and a zero-height element renders nothing.
    const raf = requestAnimationFrame(() => {
      try {
        viz = renderer.createViz({ theme: THEME });
        // setResult expects a malloy-interfaces Result; the backend forwards it verbatim.
        viz.setResult(result as any);
        viz.render(el);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      try {
        viz?.remove?.();
        el.innerHTML = '';
      } catch {
        /* noop */
      }
    };
  }, [result]);

  if (error) {
    return <div className="chart-error">Couldn't render chart: {error}</div>;
  }
  // Inline size wins over the render library's injected styles; vega sizes the
  // chart from this element, so it must have concrete dimensions. The caller
  // sizes it to the data, and the stylesheet can still cap it on small screens
  // via --chart-max. A table brings its own height, so it only gets a ceiling.
  return (
    <div
      className={`malloy-chart${columns ? ' fitted-cols' : ''}`}
      ref={ref}
      style={{
        display: 'block',
        width: '100%',
        ...(columns ? ({ '--table-cols': columns } as Record<string, string>) : null),
        ...(height === null
          ? { maxHeight: 'var(--chart-max, 360px)', overflowY: 'auto' }
          : { height: `min(${height}px, var(--chart-max, ${height}px))` }),
      }}
    />
  );
}
