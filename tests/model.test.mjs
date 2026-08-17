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
