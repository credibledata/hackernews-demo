// The visual result under an answer. Owns the chart/table switch, the empty
// state, and the CSV download — and keeps the Vega-backed renderer behind a
// lazy import so it stays off the critical path.

import { lazy, Suspense, useState } from 'react';
import { DataTable, rendersAsChart, rowsOf } from './resultView';

const MalloyChart = lazy(() =>
  import('./MalloyChart').then((m) => ({ default: m.MalloyChart }))
);

// Charts take their size from the container, so a four-category bar chart in a
// 320px box is mostly empty space — the box grows with the data instead of
// always reserving the maximum. Tuned against the renderer's own axis and mark
// metrics (~28px per category plus the axis chrome).
const ROW_PX = 30;
const CHROME_PX = 56;
const MIN_PX = 150;
const MAX_PX = 320;
const heightFor = (rows: number) =>
  Math.max(MIN_PX, Math.min(MAX_PX, rows * ROW_PX + CHROME_PX));

export function ChartCard({ data }: { data: any }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const rows = rowsOf(data);
  // Without a chart tag the renderer draws a table, so a Chart/Table switch
  // would offer the same thing twice — show the one render and drop the toggle.
  const isChart = rendersAsChart(data);
  const height = isChart ? heightFor(rows.length) : null;

  if (!rows.length) {
    return (
      <div className="chart-card">
        <div className="chart-empty">The query ran but returned no rows.</div>
      </div>
    );
  }

  return (
    <div className="chart-card">
      {/* Only the view switch lives here. A table-only result gets no toolbar
          at all, so it starts at the top of the card instead of under a band of
          white space — the CSV export sits with the answer's other actions. */}
      {isChart && (
        <div className="chart-toolbar">
          <div className="chart-views" role="group" aria-label="Result view">
            <button
              className={`chart-view ${view === 'chart' ? 'active' : ''}`}
              onClick={() => setView('chart')}
              aria-pressed={view === 'chart'}
            >
              Chart
            </button>
            <button
              className={`chart-view ${view === 'table' ? 'active' : ''}`}
              onClick={() => setView('table')}
              aria-pressed={view === 'table'}
            >
              Table
            </button>
          </div>
        </div>
      )}

      {!isChart || view === 'chart' ? (
        <Suspense
          fallback={<div className="chart-skeleton" style={{ height: height ?? MIN_PX }} aria-label="Loading result" />}
        >
          <MalloyChart result={data} height={height} />
        </Suspense>
      ) : (
        <DataTable data={data} />
      )}
    </div>
  );
}
