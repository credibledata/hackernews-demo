// What the demo is answering from: how many rows are loaded and the window they
// cover. The claim this demo makes is that the numbers are right, so the UI
// should say what "the data" actually is instead of leaving it implicit.
//
// Read from the model itself rather than from the ETL's bookkeeping, so it
// describes what Publisher is currently serving — including after a refresh
// swaps the data directory underneath it.

import { cached } from './cache.mjs';
import { runQuery } from './publisher.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.HN_DATA_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package/data');

async function metadata() {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, '.metadata.json'), 'utf8'));
  } catch (e) {
    if (e?.code !== 'ENOENT') console.error('[dataset] metadata', e?.message || e);
    return {};
  }
}

const STORIES = `run: stories -> {
  aggregate:
    stories is count()
    first_post is time.min()
    last_post is time.max()
}`;

const COMMENTS = `run: comments -> { aggregate: comments is count() }`;

/** First row of a Result as { fieldName: value }. */
function firstRow(result) {
  const fields = result?.schema?.fields ?? [];
  const cells = result?.data?.array_value?.[0]?.record_value ?? [];
  const row = {};
  fields.forEach((field, i) => {
    const cell = cells[i];
    row[field.name] =
      cell?.number_value ?? cell?.string_value ?? cell?.timestamp_value ?? cell?.date_value ?? null;
  });
  return row;
}

async function compute() {
  const [storyRow, commentRow, meta] = await Promise.all([
    runQuery(STORIES).then(firstRow),
    runQuery(COMMENTS).then(firstRow),
    metadata(),
  ]);
  if (!storyRow.stories || !storyRow.first_post || !storyRow.last_post) return null;
  return {
    stories: storyRow.stories,
    comments: commentRow.comments ?? 0,
    from: storyRow.first_post,
    to: storyRow.last_post,
    refreshedAt: meta.refreshedAt,
    scoresRefreshed: meta.scoresRefreshed,
  };
}

// Follows the daily refresh without asking Publisher on every page load.
export const getDataset = cached(compute, {
  ttlMs: Number(process.env.HN_DATASET_TTL_MS || 6 * 60 * 60 * 1000),
  label: 'dataset',
});
