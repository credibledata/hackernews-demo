// Starter questions for the empty state, derived from the data instead of a
// fixed list: pull the current top stories, let the model read the themes in
// their titles, and turn those into questions the Malloy model can actually
// answer. Computed at most once a week (cached on disk, so restarts don't
// re-roll them), with a hard fallback so the UI always has chips to show.

import OpenAI from 'openai';
import { cacheFile, cached } from './cache.mjs';
import { config } from './config.mjs';
import { runQuery } from './publisher.mjs';

const client = new OpenAI(); // reads OPENAI_API_KEY

// Shown if the model call or the query fails — the classic demo questions.
const FALLBACK = [
  'Which domains get the highest average score?',
  'What are the best hours to post for a high score?',
  'How has Ask HN vs Show HN volume changed over time?',
  'Who are the most active commenters?',
];

// Chips are one line in the empty state, so long questions truncate.
const MAX_WORDS = 12;
const wordCount = (q) => q.split(/\s+/).length;

// Highest-scoring stories — their titles are the signal for "what's interesting".
const TOP_STORIES_QUERY = `run: stories -> {
  select: title, category, score
  where: title is not null
  order_by: score desc
  limit: 100
}`;

// What the model can answer, so generated questions stay grounded (and thus
// answerable) rather than drifting into things the slice doesn't cover.
const CAPABILITIES = `The model covers Hacker News stories and comments. It can slice by:
- score (avg/max), comment counts, and the score distribution
- domain, submission category (Ask HN / Show HN / Job / Link)
- posting hour of day and day of week, and monthly trends over time
- most prolific submitters and most active commenters
- story titles, so questions can zoom in on a topic via a title keyword.`;

/** Pull the `title` column out of a malloy-interfaces Result (rows → cells). */
function titlesFrom(result, limit = 100) {
  const fields = result?.schema?.fields ?? [];
  const titleIdx = fields.findIndex((f) => f?.name === 'title');
  const rows = result?.data?.array_value ?? [];
  if (titleIdx < 0 || !Array.isArray(rows)) return [];
  const titles = [];
  for (const row of rows) {
    const value = row?.record_value?.[titleIdx]?.string_value;
    if (typeof value === 'string' && value.trim()) titles.push(value.trim());
    if (titles.length >= limit) break;
  }
  return titles;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: { type: 'string' },
    },
  },
};

async function compute() {
  const result = await runQuery(TOP_STORIES_QUERY);
  const titles = titlesFrom(result);
  if (titles.length < 10) return null; // not enough signal — use the fallback

  const resp = await client.responses.create({
    model: config.model,
    // Headroom for reasoning models: reasoning tokens count against this budget,
    // and a truncated response yields empty output_text → JSON.parse fails.
    max_output_tokens: 4000,
    instructions:
      'You write starter questions for a Hacker News analytics demo. Given the ' +
      'titles of the current top stories and what the underlying model can answer, ' +
      'return exactly 4 short, plain-English questions a curious user would click. ' +
      `Every question must be ${MAX_WORDS} words or fewer — count the words. ` +
      'Make 2 of them reference concrete themes you see trending in the titles ' +
      '(e.g. a technology or topic), phrased so they stay answerable from the ' +
      'listed capabilities (a title keyword filter is fine). Keep the rest as ' +
      'broad analytical questions. One sentence each, no numbering, no preamble.',
    input:
      `${CAPABILITIES}\n\nCurrent top story titles:\n` +
      titles.map((t) => `- ${t}`).join('\n'),
    text: { format: { type: 'json_schema', name: 'starter_questions', schema: SCHEMA, strict: true } },
  });

  const parsed = JSON.parse(resp.output_text);
  // The length cap is a prompt instruction, so enforce it here too: drop any
  // over-long question rather than letting it truncate in the UI.
  const questions = (parsed.questions || [])
    .map((q) => String(q).trim())
    .filter((q) => q && wordCount(q) <= MAX_WORDS);
  return questions.length >= 3 ? questions : null;
}

// Re-derived weekly, not per boot: the questions are the first thing a visitor
// sees, so they should be stable, and the disk-backed TTL means a restart (or a
// redeploy) doesn't quietly reshuffle them.
export const getSuggestions = cached(compute, {
  ttlMs: Number(process.env.HN_SUGGESTIONS_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  retryMs: Number(process.env.HN_SUGGESTIONS_RETRY_MS || 60 * 1000),
  fallback: FALLBACK,
  file: cacheFile('suggestions.json'),
  label: 'suggestions',
});
