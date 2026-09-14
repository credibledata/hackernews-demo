// The two "Try next" questions offered under an answer.
//
// Derived from the Malloy that actually ran, the same way interpretation.mjs
// derives the explanation: the query names a view or a set of fields, and the
// adjacent cut of the model is a fact about the model, not something the LLM
// should be asked to invent. A generated suggestion can propose a question this
// slice cannot answer — the one failure this demo can least afford — whereas
// every question below maps to a view, dimension, or measure in hn.malloy.
//
// Keep in step with the model: a view renamed there and not here simply stops
// matching, and the client falls back to the starter questions.

export const SUGGESTIONS = {
  top_domains: [
    'Which domains clear 100 points most often?',
    'Do Ask HN and Show HN posts outscore link submissions?',
  ],
  score_by_hour: [
    'Does the same pattern hold across days of the week?',
    'When do comments arrive, compared with stories?',
  ],
  score_by_dow: [
    'Which hour of the day scores best?',
    'Has story volume shifted month over month?',
  ],
  by_category: [
    'Which category draws the longest comments?',
    'How rare is a story that clears 100 points?',
  ],
  score_distribution: [
    'What share of stories clear 100 points?',
    'Which domains clear that bar most often?',
  ],
  most_prolific_authors: [
    'Who has the best success rate, not just the most posts?',
    'Who are the most active commenters?',
  ],
  most_discussed: [
    'Do the most-discussed stories also score highest?',
    'Which categories attract the most comments?',
  ],
  stories_per_month: [
    'Has the average score moved over those months?',
    'Which domains show up most in this window?',
  ],
  top_commenters: [
    'Which stories drew the most comments?',
    'What hours do comments arrive?',
  ],
  comments_by_hour: [
    'Do stories get posted on the same hourly rhythm?',
    'Who comments most?',
  ],
  avg_length_by_category: [
    'Which categories score best?',
    'Which stories drew the most comments?',
  ],
  // Not a view: the shape a topic search takes. Its questions refer back to the
  // question asked ("this topic"), which resolves because a chip is sent with
  // the thread's history, exactly as a typed follow-up would be.
  topic: [
    'Which domains publish most about this topic?',
    "How has this topic's volume changed month over month?",
  ],
};

// A named view is the most specific thing a query can say about itself, so it
// decides before any field heuristic. Word boundaries keep the near-misses
// apart: `by_category` must not match inside `avg_length_by_category`.
const VIEW_PATTERNS = Object.keys(SUGGESTIONS)
  .filter((key) => key !== 'topic')
  .map((view) => [new RegExp(`\\b${view}\\b`), view]);

// Custom Malloy, matched on the fields it reaches for. First match wins, so the
// order is most- to least-specific: a topic search is about its topic even when
// it also groups by domain.
const FIELD_PATTERNS = [
  [/\btitle_words\b/, 'topic'],
  [/\bdomain\b/, 'top_domains'],
  [/\bpost_hour\b|\bpost_dow\b/, 'score_by_hour'],
  [/\bcategory\b/, 'by_category'],
  [/\bauthor\b/, 'most_prolific_authors'],
  [/\bis_successful\b|\bsuccess_rate\b|\bscore_tier\b/, 'score_distribution'],
];

/**
 * Up to two follow-up questions for the query an answer rests on.
 * @param {string} query the primary Malloy query
 * @returns {string[]} two questions, or none when the query matches nothing
 */
export function followUpsFor(query) {
  const source = String(query || '');
  const match =
    VIEW_PATTERNS.find(([pattern]) => pattern.test(source)) ??
    FIELD_PATTERNS.find(([pattern]) => pattern.test(source));
  return match ? [...SUGGESTIONS[match[1]]] : [];
}
