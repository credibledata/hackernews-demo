// Shared readers over a malloy-interfaces Result: the row table, CSV export and
// cell formatting. Used by both the chart card (its "Table" view) and the
// under-the-hood Data tab, so the two can't drift apart.

/** Read a Malloy cell's scalar value for display. */
export function cellText(cell: any): string {
  if (!cell || typeof cell !== 'object') return '';
  if (cell.kind === 'null_cell' || cell.null_value !== undefined) return '—';
  const value =
    cell.string_value ??
    cell.number_value ??
    cell.boolean_value ??
    cell.date_value ??
    cell.timestamp_value;
  if (value === undefined || value === null) return '—';
  // Decimals arrive at full float precision; trim to something readable.
  if (typeof value === 'number' && !Number.isInteger(value)) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}

export const fieldsOf = (data: any): any[] => data?.schema?.fields ?? [];
export const rowsOf = (data: any): any[] => data?.data?.array_value ?? [];

// @malloydata/render picks its renderer from the query's own tags, which
// Publisher hands back verbatim as the result's annotations. Only the three
// vega-backed plugins fill the height they're given; everything else — above
// all the table an untagged query falls back to — sizes to its content.
const CHART_TAG = /^#\s*(?:bar_chart|line_chart|scatter_chart|viz\s*=\s*"?(?:bar|line)\b)/;

/** Whether this result will draw as a chart rather than a table. */
export const rendersAsChart = (data: any): boolean =>
  (data?.annotations ?? []).some((a: any) => CHART_TAG.test(a?.value ?? ''));

const MAX_ROWS = 100;

export function DataTable({ data, maxRows = MAX_ROWS }: { data: any; maxRows?: number }) {
  const fields = fieldsOf(data);
  const rows = rowsOf(data);
  if (!fields.length || !rows.length) return <div className="hood-empty">No rows returned.</div>;

  const shown = rows.slice(0, maxRows);
  return (
    <div className="hood-table-wrap">
      <table className="hood-table">
        <thead>
          <tr>
            {fields.map((f) => (
              <th key={f.name}>{f.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {fields.map((f, j) => {
                const cell = row?.record_value?.[j];
                return (
                  <td key={f.name} className={cell?.kind === 'number_cell' ? 'num' : undefined}>
                    {cellText(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div className="hood-note">
          Showing {shown.length} of {rows.length} rows.
        </div>
      )}
    </div>
  );
}

/** Rows as CSV, so a result can leave the page without a round-trip. */
export function toCsv(data: any): string {
  const fields = fieldsOf(data);
  const escape = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [fields.map((f) => escape(f.name)).join(',')];
  for (const row of rowsOf(data)) {
    lines.push(fields.map((_, j) => escape(cellText(row?.record_value?.[j]))).join(','));
  }
  return lines.join('\n');
}

/** Save the result as a file. Clipboard copy suits a snippet; a real download
 *  suits a result someone wants to open in a spreadsheet. */
export function downloadCsv(data: any, filename = 'hn-result.csv') {
  const blob = new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
