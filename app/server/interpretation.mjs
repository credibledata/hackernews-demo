// A short, deterministic explanation of the semantic choices in the query.
// This is derived from the Malloy that actually ran, so it does not ask the LLM
// to make a second, potentially inconsistent claim about what its answer means.

const VIEW_MEANINGS = [
  [/\btop_domains\b/, 'average story score by normalized host, limited to hosts with at least 20 stories'],
  [/\bscore_by_hour\b/, 'story volume and average score by posting hour (Pacific); this is correlation, not causal posting advice'],
  [/\bscore_by_dow\b/, 'story volume and average score by day of week (Pacific); this is correlation, not causal posting advice'],
  [/\btop_commenters\b/, 'comment rows in this dataset slice, grouped by commenter'],
  [/\bmost_discussed\b/, 'current HN thread comment totals, with in-slice comment rows shown separately'],
  [/\bscore_distribution\b/, 'story counts in the model’s governed score buckets'],
  [/\bmost_prolific_authors\b/, 'story submissions grouped by HN username, ranked by volume posted — not by how well those stories did'],
  [/\bby_category\b/, 'story counts using the model’s governed Ask HN, Show HN, Job, and Link classification'],
];

export function interpretationFor(query) {
  const source = String(query || '');
  for (const [pattern, meaning] of VIEW_MEANINGS) {
    if (pattern.test(source)) return meaning;
  }

  const details = [];
  const scored = /\bavg_score\b|score\.avg\s*\(/.test(source);
  if (scored) details.push('“performance” measured by average HN story score');
  if (/\bsuccess_rate\b|\bsuccessful_count\b|\bis_successful\b/.test(source)) {
    details.push('“successful” meaning the model’s 100-point threshold, not an HN concept');
  }
  // Only alongside a score: on its own, a story count is the answer the reader
  // asked for, and calling it a caveat would be noise.
  if (scored && /\bstory_count\b/.test(source)) {
    details.push('story counts shown as sample size, not as a success measure');
  }
  if (/\bdomain\b/.test(source)) details.push('hosts normalized to lowercase with a leading “www.” removed');
  if (/\bpost_hour\b|\bpost_dow\b/.test(source)) details.push('posting times in Pacific time');
  if (/\bcategory\b/.test(source)) details.push('the model’s governed submission categories');
  if (/\bcomment_count\b|\bavg_comments\b|\bdescendants\b/.test(source)) details.push('current HN thread comment totals');
  if (/\b(avg_)?thread_comments\b|count\s*\(\s*thread\.id\s*\)/.test(source)) details.push('comment rows present in this dataset slice');
  if (/\btitle_words\b/.test(source)) details.push('case-normalized story-title matching');

  return details.length
    ? details.join('; ')
    : 'the documented dimensions, measures, joins, and filters in the governed Malloy query shown below';
}
