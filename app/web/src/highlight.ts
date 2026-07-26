// Minimal tokenizer for the Malloy and SQL shown in the "under the hood" panel.
// Deliberately dependency-free: a real highlighting library costs more transfer
// than the whole rest of the app, and these snippets are short and predictable.
// Returns tokens for the caller to render as spans — no HTML injection.

export type Token = { text: string; cls: string };

const MALLOY_KEYWORDS = new Set([
  'run', 'source', 'is', 'extend', 'select', 'where', 'having', 'limit', 'nest',
  'group_by', 'aggregate', 'order_by', 'calculate', 'dimension', 'measure',
  'view', 'join_one', 'join_many', 'join_cross', 'on', 'with', 'declare',
  'primary_key', 'query', 'index', 'sample', 'top', 'by', 'asc', 'desc', 'and',
  'or', 'not', 'null', 'true', 'false', 'pick', 'when', 'then', 'else', 'end',
]);

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'order', 'by', 'having', 'limit', 'offset',
  'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'as', 'and',
  'or', 'not', 'in', 'is', 'null', 'distinct', 'union', 'all', 'case', 'when',
  'then', 'else', 'end', 'asc', 'desc', 'with', 'between', 'like', 'cast',
  'over', 'partition', 'exists',
]);

const FUNCTIONS = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'round', 'floor', 'ceil', 'abs', 'concat',
  'lower', 'upper', 'length', 'substr', 'coalesce', 'row_number', 'rank',
]);

// Order matters: comments and strings must win over identifiers and operators.
const PATTERN = new RegExp(
  [
    '(--[^\\n]*|//[^\\n]*|#[^\\n]*)', // 1 comment (# covers Malloy tags)
    "('(?:[^']|'')*'|\"(?:[^\"]|\"\")*\")", // 2 string
    '(\\b\\d+(?:\\.\\d+)?\\b)', // 3 number
    '([A-Za-z_][A-Za-z0-9_]*)', // 4 word
    '(\\s+)', // 5 whitespace
    '([^\\s\\w])', // 6 punctuation/operator
  ].join('|'),
  'g'
);

export function tokenize(code: string, lang: 'malloy' | 'sql'): Token[] {
  const keywords = lang === 'malloy' ? MALLOY_KEYWORDS : SQL_KEYWORDS;
  const tokens: Token[] = [];
  let match: RegExpExecArray | null;
  PATTERN.lastIndex = 0;

  while ((match = PATTERN.exec(code)) !== null) {
    const [text, comment, str, num, word, space] = match;
    if (comment) tokens.push({ text, cls: 'c' });
    else if (str) tokens.push({ text, cls: 's' });
    else if (num) tokens.push({ text, cls: 'n' });
    else if (word) {
      const lower = word.toLowerCase();
      if (keywords.has(lower)) tokens.push({ text, cls: 'k' });
      else if (FUNCTIONS.has(lower)) tokens.push({ text, cls: 'f' });
      else tokens.push({ text, cls: '' });
    } else if (space) tokens.push({ text, cls: '' });
    else tokens.push({ text, cls: 'p' });
  }
  return tokens;
}
