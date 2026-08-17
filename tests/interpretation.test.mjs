import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretationFor } from '../app/server/interpretation.mjs';

test('named views explain their governed definition', () => {
  assert.match(interpretationFor('run: stories -> top_domains'), /at least 20 stories/);
  assert.match(interpretationFor('run: stories -> score_by_hour'), /Pacific/);
  assert.match(interpretationFor('run: stories -> score_by_hour'), /not causal/);
  assert.match(interpretationFor('run: stories -> most_discussed'), /current HN thread/);
});

test('custom queries describe the semantic fields they use', () => {
  const value = interpretationFor(`run: stories -> {
    group_by: domain, post_hour
    aggregate: avg_score
  }`);
  assert.match(value, /average HN story score/);
  assert.match(value, /normalized/);
  assert.match(value, /Pacific/);
});

// The "engagement" starter chip lands here: the agent writes an ad-hoc query,
// and which comment count it reached for is exactly what the reader needs told.
test('the two comment definitions are named apart', () => {
  const wholeThread = interpretationFor(`run: stories -> {
    group_by: category
    aggregate: avg_comments
  }`);
  assert.match(wholeThread, /current HN thread comment totals/);

  const inSlice = interpretationFor(`run: stories -> {
    group_by: category
    aggregate: avg_thread_comments
  }`);
  assert.match(inSlice, /comment rows present in this dataset slice/);
});

// Ranking views show story_count next to avg_score as sample size — how much
// the average rests on — but a reader looking at a table sorted by score reads
// every column in it as part of the score. Say which one it is.
test('story counts beside a score are named as sample size, not success', () => {
  const ranked = interpretationFor(`run: stories -> {
    group_by: domain
    aggregate: avg_score, story_count
  }`);
  assert.match(ranked, /sample size/);
  assert.doesNotMatch(
    interpretationFor('run: stories -> { group_by: category; aggregate: story_count }'),
    /sample size/,
    'a plain count is the answer, not a caveat on one'
  );
});

test('unknown query shapes still get an honest generic interpretation', () => {
  assert.match(interpretationFor('run: stories -> { select: title }'), /governed Malloy query/);
});
