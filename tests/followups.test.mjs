import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpsFor, SUGGESTIONS } from '../app/server/followups.mjs';

test('a named view offers the adjacent cuts of the same model', () => {
  const hour = followUpsFor('run: stories -> score_by_hour');
  assert.equal(hour.length, 2);
  assert.match(hour[0], /days? of the week/i);
  assert.match(hour[1], /comment/i);

  // top_domains' own doc says to read success_rate beside avg_score, because a
  // single huge story can carry an average. That caveat is the obvious next ask.
  assert.match(followUpsFor('run: stories -> top_domains')[0], /100 points/);

  // Same for most_prolific_authors: volume is not success, and the view says so.
  assert.match(followUpsFor('run: stories -> most_prolific_authors')[0], /success rate/i);
});

test('a custom query is matched on the fields it uses', () => {
  const byDomain = followUpsFor(`run: stories -> {
    group_by: domain
    aggregate: avg_score
  }`);
  assert.equal(byDomain.length, 2);
  assert.match(byDomain.join(' '), /domain/i);

  // A topic search is the one shape whose follow-up has to refer back to the
  // question ("this topic"): the chips are asked with the thread's history, so
  // the agent resolves it the same way a typed follow-up would.
  const topic = followUpsFor(`run: stories -> {
    where: title_words ~ r'\\brust\\b'
    aggregate: story_count
  }`);
  assert.match(topic.join(' '), /this topic/i);
});

test('a named view wins over the fields inside it', () => {
  // score_by_hour groups by post_hour, which the field heuristics also match.
  // The view is the more specific fact about the query, so it decides.
  assert.deepEqual(
    followUpsFor('run: stories -> score_by_hour'),
    SUGGESTIONS.score_by_hour
  );
});

test('an unrecognised query suggests nothing rather than something wrong', () => {
  // Better a missing row than a chip that sends the reader somewhere the slice
  // cannot answer — the client falls back to the starters.
  assert.deepEqual(followUpsFor('run: stories -> { select: title }'), []);
  assert.deepEqual(followUpsFor(''), []);
  assert.deepEqual(followUpsFor(null), []);
});

test('every suggestion is a distinct, self-contained question', () => {
  const all = Object.values(SUGGESTIONS).flat();
  for (const q of all) {
    assert.ok(q.length > 0 && q.length <= 70, `too long for a chip: ${q}`);
    assert.match(q, /\?$/, `not a question: ${q}`);
  }
  for (const [view, pair] of Object.entries(SUGGESTIONS)) {
    assert.equal(pair.length, 2, `${view} must offer exactly two`);
    assert.notEqual(pair[0], pair[1], `${view} offers the same question twice`);
  }
});
