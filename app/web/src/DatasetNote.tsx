// One line stating what the answers are computed from — including where the
// data came from. The demo's argument is that the numbers are right, which is
// worth little if the reader can't tell what data produced them.

import type { Dataset } from './api';

const SOURCE_URL = 'https://huggingface.co/datasets/open-index/hacker-news';

const monthYear = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "Jun 2012 – Jul 2012", or just "Jun 2012" when the window is one month. */
function span(from: string, to: string) {
  const start = monthYear(from);
  const end = monthYear(to);
  return start === end ? start : `${start} – ${end}`;
}

// Two deliberate lines — the counts and window as a stat row, the provenance
// under it — so the note never wraps mid-phrase. Each stat is its own element
// and the CSS draws the separators and keeps every stat unbroken.
export function DatasetNote({ dataset, className = 'dataset-note' }: { dataset: Dataset | null; className?: string }) {
  if (!dataset) return null;
  return (
    <div className={className}>
      <span className="dataset-stats">
        <span>
          <b>{dataset.stories.toLocaleString()}</b> stories
        </span>
        <span>
          <b>{dataset.comments.toLocaleString()}</b> comments
        </span>
        <span>{span(dataset.from, dataset.to)}</span>
      </span>
      <span className="dataset-source">
        from{' '}
        <a href={SOURCE_URL} target="_blank" rel="noreferrer">
          open-index/hacker-news
        </a>{' '}
        on Hugging Face
      </span>
    </div>
  );
}
