// Guards on the semantic model itself. The model file is the contract the agent
// reads over MCP, so a claim in a #(doc) that the query no longer honours is
// worse than no claim at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const TIMEZONE = 'America/Los_Angeles';
const model = await readFile(new URL('../package/hn.malloy', import.meta.url), 'utf8');

/** The text of one top-level `source:` block, up to the next source declaration. */
function sourceBody(name) {
  const start = model.indexOf(`source: ${name} is`);
  assert.notEqual(start, -1, `no source named ${name}`);
  const next = model.indexOf('\nsource: ', start + 1);
  return model.slice(start, next === -1 ? undefined : next);
}

// Malloy computes hour(), day_of_week() and month truncation in the query
// timezone, and @malloydata/db-duckdb pins the DuckDB session to UTC. Drop this
// statement and every posting-time answer silently reverts to UTC while the
// docs still say Pacific — no error, just wrong hours.
test('both queryable sources fix the query timezone to Pacific', () => {
  for (const name of ['comments', 'stories']) {
    assert.match(
      sourceBody(name),
      new RegExp(`timezone:\\s*'${TIMEZONE}'`),
      `source ${name} must declare its query timezone`
    );
  }
});

// `is_successful` and `score_tier` both cut at 100 points, and the dimension's
// #(doc) tells the agent they are the same line ("exactly tiers 4 and 5"). Move
// one boundary without the other and that claim goes quietly false — the agent
// would report a success rate that disagrees with the distribution beside it.
test('is_successful cuts at the same score as score_tier', () => {
  const body = sourceBody('stories');
  const flag = body.match(/is_successful is score >= (\d+)/);
  assert.ok(flag, 'stories must define is_successful as a score threshold');
  assert.match(
    body,
    new RegExp(`pick '4\\. ${flag[1]}–\\d+' when score < \\d+`),
    `score_tier must open a bucket at ${flag[1]}, the is_successful threshold`
  );
});

// avg_score is a mean over a power law — one 2,000-point story lifts a domain's
// average for good. Every view that ranks by it carries success_rate alongside,
// which no single outlier can move. Ship one without the other and the ranking
// silently goes back to rewarding luck.
test('views that rank by avg_score also report success_rate', () => {
  const body = sourceBody('stories');
  for (const view of ['top_domains', 'by_category']) {
    const block = body.slice(body.indexOf(`view: ${view} is`)).split('\n  #(doc)')[0];
    assert.match(block, /\bavg_score\b/, `${view} should still report avg_score`);
    assert.match(block, /\bsuccess_rate\b/, `${view} must report success_rate beside avg_score`);
  }
});

// `top_authors` ranked by story_count read as "the best authors" to any agent
// picking a view by name, turning volume into quality. The name has to say
// volume as plainly as the ordering does.
test('no view named "top" is ordered by raw story volume', () => {
  const body = sourceBody('stories');
  const views = [...body.matchAll(/view: (\w+) is \{([\s\S]*?)\n  \}/g)];
  assert.ok(views.length, 'expected to find views in the stories source');
  const misnamed = views
    .filter(([, name]) => /^top_/.test(name))
    .filter(([, , block]) => /order_by: story_count desc/.test(block))
    .map(([, name]) => name);
  assert.deepEqual(misnamed, [], 'these views rank by volume under a "top" name');
});

// `stories` gives the agent four ways to bucket time; `comments` gave it one,
// so any question about comment activity by day or by month forced the agent to
// write day_of_week() by hand — the per-question invention the model exists to
// prevent. The two sources' time dimensions stay in step.
test('both sources bucket time the same ways', () => {
  const stories = sourceBody('stories');
  const comments = sourceBody('comments');
  for (const dim of ['post_hour', 'post_dow', 'post_month']) {
    for (const [name, body] of [['stories', stories], ['comments', comments]]) {
      assert.match(body, new RegExp(`\\n    ${dim} is `), `${name} must define ${dim}`);
    }
  }
});

// Dropped deliberately, each for its own reason: post_year holds one value in a
// 12-month window, total_score is a volume number sitting in performance tables,
// and ask_vs_show_over_time is stories_per_month plus a two-value filter the
// agent composes on its own. Re-adding one should be a decision, not a reflex.
test('the fields removed as noise stay removed', () => {
  for (const gone of ['post_year', 'total_score', 'ask_vs_show_over_time']) {
    assert.doesNotMatch(model, new RegExp(`\\b${gone}\\b`), `${gone} is back in the model`);
  }
});

// The "How this works" panel shows this file, so the path the server resolves
// has to land on the real model — a wrong path only shows up as an empty panel
// in the browser, which is exactly the kind of break nobody notices in CI.
test('the server resolves the model source from disk', async () => {
  const { getModelSource } = await import('../app/server/model.mjs');
  const text = await getModelSource();
  assert.match(text, /source: stories is stories_base extend/);
  assert.equal(text, await getModelSource(), 'repeat reads must agree');
});

test('a missing model file rejects rather than serving an empty panel', async () => {
  process.env.HN_MODEL_PATH = '/nonexistent/hn.malloy';
  try {
    const { getModelSource } = await import('../app/server/model.mjs?missing');
    await assert.rejects(getModelSource(), /ENOENT/);
  } finally {
    delete process.env.HN_MODEL_PATH;
  }
});

// The #(doc) notes are what the agent reads over MCP to ground itself, so one
// still saying UTC would have it label Pacific numbers as UTC in the answer.
test('no #(doc) note describes its times as UTC', () => {
  const stale = model.split('\n').filter((l) => l.includes('#(doc)') && /\bUTC\b/.test(l));
  assert.deepEqual(stale, [], 'these #(doc) notes still claim UTC');
});

// ── The reliable-score guard ────────────────────────────────────────────
//
// `score` and `descendants` are ingest-time snapshots that prep/build-data.mjs
// re-reads from the HN API, together, in one UPDATE — but only for stories
// younger than HN_REFRESH_SCORES_DAYS. The upstream archive backfills the rest
// on its own schedule, and that schedule lags the refresh window by months. In
// the slice this was written against, ten of thirty-six months carried raw
// ingest values: average score 2.3 against 18.8 either side of the gap, and
// 60% of stories sitting at exactly 1 point. Nothing errors. The numbers simply
// come out ~8x low for a quarter of the corpus.
//
// The guard is `score_coverage` — the ratio of the two comment measures. Both
// count the same thing, so they agree (0.98–1.02) wherever the refresh reached
// and collapse (0.04–0.06) wherever it didn't. It needs no hardcoded dates,
// which matters because the window rolls forward on every rebuild.

/** A field's `#(doc)` and render tags — the lines the agent reads over MCP. */
function fieldDoc(body, name) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^    ${name} is\\b`).test(l));
  assert.notEqual(i, -1, `stories must define ${name}`);
  const doc = [];
  for (let j = i - 1; j >= 0 && lines[j].trim().startsWith('#'); j--) doc.unshift(lines[j].trim());
  return doc.join('\n');
}

/** A field's definition, including any lines it wraps onto. */
function fieldDef(body, name) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^    ${name} is\\b`).test(l));
  assert.notEqual(i, -1, `stories must define ${name}`);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && !/^(    [#\w]|  \w|\})/.test(lines[j]); j++) out.push(lines[j]);
  return out.join('\n');
}

// Every field below is computed from `score` or `descendants`, directly or
// through another field that is. An agent reaching over MCP sees one field's
// #(doc) and not the file around it, so the warning has to travel on each of
// them — a caveat in a comment block three screens up is a caveat nobody reads.
const SCORE_DERIVED = [
  'comment_count', 'score_tier', 'is_successful',
  'avg_score', 'max_score', 'avg_comments',
  'successful_count', 'success_rate',
];

test('every score-derived field points at score_coverage', () => {
  const body = sourceBody('stories');
  const silent = SCORE_DERIVED.filter((f) => !/score_coverage/.test(fieldDoc(body, f)));
  assert.deepEqual(silent, [], 'these fields can read 8x low without saying so');
});

// The list above is only as good as its coverage. A new measure over `score`
// that nobody adds to it would ship the exact bug this guard exists to catch,
// so the test finds them itself rather than trusting the list to be current.
test('no field touches score or descendants without being declared score-derived', () => {
  const body = sourceBody('stories');
  const declared = new Set([...SCORE_DERIVED, 'score_coverage']);
  const undeclared = [...body.matchAll(/^    (\w+) is\b/gm)]
    .map(([, name]) => name)
    .filter((name) => !declared.has(name))
    .filter((name) => /\b(score|descendants)\b/.test(fieldDef(body, name)));
  assert.deepEqual(undeclared, [], 'these read refreshed columns but carry no warning');
});

// The whole guard rests on the two measures counting the same thing by
// different routes: `avg_comments` from the refreshed `descendants` column,
// `avg_thread_comments` from comment rows that are never refreshed and so never
// go stale. Redefine either and the ratio stops meaning "did the refresh reach
// these rows" while still returning a plausible number.
test('score_coverage is the ratio of the two comment measures', () => {
  const body = sourceBody('stories');
  assert.match(
    fieldDef(body, 'score_coverage'),
    /score_coverage is avg_comments \/ avg_thread_comments/,
    'score_coverage must compare the refreshed count against the comment rows'
  );
  assert.match(fieldDef(body, 'avg_comments'), /descendants/);
  assert.match(fieldDef(body, 'avg_thread_comments'), /count\(thread\.id\)/);
});

// A ratio nobody can see is a ratio nobody checks. The view is the answer to
// "is this window safe to trend over", and it has to be reachable by name.
test('score_health exposes coverage per month', () => {
  const body = sourceBody('stories');
  const block = body.slice(body.indexOf('view: score_health is')).split('\n  #(doc)')[0];
  assert.ok(block.startsWith('view: score_health is'), 'stories must define a score_health view');
  assert.match(block, /group_by: post_month/, 'score_health must break coverage down by month');
  assert.match(block, /score_coverage/, 'score_health must report score_coverage');
});
