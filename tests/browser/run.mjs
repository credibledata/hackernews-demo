// Browser tests for the chat UI. Hermetic: a mock backend replaces the model,
// so these need no API key and no Publisher — just Chrome and the Vite dev
// server, both started and torn down here.
//
//   npm run test:browser
//
// These cover the behaviour that unit tests can't reach and that broke more than
// once during development: scroll pinning while an answer streams, Stop, the
// ?q= permalink, theme persistence, and the follow-up chips.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';
import { SUGGESTIONS } from '../../app/server/followups.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_PORT = Number(process.env.HN_TEST_WEB_PORT || 5173);
const MOCK_PORT = Number(process.env.HN_TEST_MOCK_PORT || 8787);
const UI = `http://localhost:${WEB_PORT}`;
const children = [];

// The starter questions are fixed UI copy: the empty state has no answer to
// follow on from, so its chips can only come from the frontend. Each one leans
// on a term the Malloy model defines ("an AI story", "engagement", "top",
// "successful"), which is the point of the demo: the answer has to say which
// definition it used. Kept in step with STARTERS in app/web/src/App.tsx by
// hand — this test is what catches the drift. The chips under an answer are the
// other case entirely: those come from the backend, derived from the query that
// answered.
const STARTERS = [
  'Has Hacker News turned into an AI news site?',
  'Do Ask HN or Show HN posts get more engagement?',
  'What share of HN comments come from the top 1,000 accounts?',
  'How rare is a successful story?',
];

let tearingDown = false;

function start(cmd, args, cwd, name) {
  const proc = spawn(cmd, args, { cwd, stdio: 'ignore', env: { ...process.env } });
  proc.on('error', (e) => console.error(`[${name}] ${e.message}`));
  // A leftover mock or dev server from an earlier run keeps the port, this one
  // dies on EADDRINUSE, and waitForHttp is happily answered by the stale
  // process — so the suite would test whatever code that one was started with.
  proc.on('exit', (code) => {
    if (tearingDown) return;
    console.error(`\nfatal: [${name}] exited with code ${code} — something else is already on its port`);
    cleanup();
    process.exit(1);
  });
  children.push(proc);
  return proc;
}

async function waitForHttp(url, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error(`${label} never became ready at ${url}`);
}

// ── tiny test harness ────────────────────────────────────────────────────────
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  NOT OK  ${name}\n        ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const assertEqual = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg} (expected ${expected}, got ${actual})`);
};

// Scroll state of the thread, as one object.
const THREAD = `
  const t = document.querySelector('.thread');
  if (!t) return null;
  return {
    st: Math.round(t.scrollTop),
    gap: Math.round(t.scrollHeight - t.scrollTop - t.clientHeight),
    overflowing: t.scrollHeight > t.clientHeight + 50,
    streaming: !!document.querySelector('.stop-btn'),
  };
`;

async function main() {
  console.log('starting mock backend and dev server…');
  process.env.MOCK_PORT = String(MOCK_PORT);
  process.env.HN_WEB_PORT = String(WEB_PORT);
  process.env.HN_CHAT_PROXY = `http://127.0.0.1:${MOCK_PORT}`;
  start(process.execPath, [path.join(ROOT, 'tests/browser/mock-backend.mjs')], ROOT, 'mock');
  start('npm', ['run', 'dev'], path.join(ROOT, 'app/web'), 'vite');

  await waitForHttp(`http://127.0.0.1:${MOCK_PORT}/chat/health`, 'mock backend');
  await waitForHttp(UI, 'vite dev server');

  const page = await launch();
  // Chrome prompts for clipboard access otherwise, which a headless run can't answer.
  await page.send('Browser.grantPermissions', {
    origin: UI,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
  console.log('running tests…\n');

  await test('empty state offers the fixed starter chips, and the MCP command lives in How this works', async () => {
    await page.goto(UI);
    await page.waitFor(`document.querySelectorAll('.empty .chip').length > 0`);
    const chips = await page.eval(`return [...document.querySelectorAll('.empty .chip')].map(c => c.textContent)`);
    assertEqual(chips.join(' | '), STARTERS.join(' | '), 'starter chips');
    assert(
      !(await page.eval(`return !!document.querySelector('.empty .mcp-connect')`)),
      'MCP block should not be on the empty state'
    );
    const scope = await page.eval(`return document.querySelector('.dataset-note')?.textContent || ''`);
    assert(/18,465 stories/.test(scope), `dataset scope missing from the empty state: "${scope}"`);
    assert(/Jun 2012/.test(scope), `dataset window missing from the empty state: "${scope}"`);
    assert(/refreshed Aug 16, 2026/.test(scope), `refresh date missing from the empty state: "${scope}"`);
    assert(/scores refreshed from HN/.test(scope), `score provenance missing from the empty state: "${scope}"`);
    assert(
      await page.eval(`return !!document.querySelector('a.source-btn')`),
      'visible source link missing from the header'
    );
    await page.eval(`
      const b = [...document.querySelectorAll('.how-btn')].find(x => x.textContent.includes('How this works'));
      b.click();
    `);
    await page.waitFor(`!!document.querySelector('.modal .mcp-copy')`);
    await page.eval(`document.querySelector('.modal-close').click()`);
  });

  await test('How this works opens the real model source in a side panel', async () => {
    await page.goto(UI);
    await page.waitFor(`document.querySelectorAll('.empty .chip').length > 0`);
    await page.eval(`
      [...document.querySelectorAll('.how-btn')].find(x => x.textContent.includes('How this works')).click();
    `);
    await page.waitFor(`!!document.querySelector('.model-toggle')`);
    await page.eval(`document.querySelector('.model-toggle').click()`);
    await page.waitFor(`!!document.querySelector('.model-panel .code')`, { label: 'model source' });

    // The panel must show the file itself, not a summary of it — the point of
    // the panel is that the reader can check the model against the answers.
    const source = await page.eval(`return document.querySelector('.model-panel .code').textContent`);
    assert(/source: stories is stories_base extend/.test(source), 'model panel is missing the stories source');
    assert(/is_successful is score >= 100/.test(source), 'model panel is missing the governed success definition');
    assert(
      await page.eval(`return !!document.querySelector('.modal.has-panel')`),
      'modal should widen into its two-column layout when the panel is open'
    );

    await page.eval(`document.querySelector('.model-toggle').click()`);
    await page.waitFor(`!document.querySelector('.model-panel')`, { label: 'panel to close' });
    await page.eval(`document.querySelector('.modal-close').click()`);
  });

  await test('?q= permalink asks the question on load', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('Which domains score best?')}`);
    await page.waitFor(`document.querySelectorAll('.msg.user').length === 1`);
    const asked = await page.eval(`return document.querySelector('.msg.user .text').textContent`);
    assertEqual(asked, 'Which domains score best?', 'permalink question');
  });

  await test('answer streams and the under-the-hood panel exposes Malloy, SQL and Data', async () => {
    await page.waitFor(`!!document.querySelector('.hood')`, { timeoutMs: 30000 });
    await page.waitFor(`!document.querySelector('.stop-btn')`, { label: 'stream to finish' });
    const interpretation = await page.eval(`return document.querySelector('.interpretation')?.textContent || ''`);
    assert(/Interpreted as:/.test(interpretation), `interpretation missing: "${interpretation}"`);
    await page.eval(`document.querySelector('.hood-toggle').click(); return 1`);
    await sleep(300);
    const tabs = await page.eval(
      `return [...document.querySelectorAll('.hood-tab')].map(t => t.textContent)`
    );
    assertEqual(tabs.length, 3, `tab count (${tabs.join(', ')})`);
    assert(tabs[0].startsWith('Malloy'), `first tab is Malloy, got ${tabs[0]}`);
    assert(tabs[1].startsWith('SQL'), `second tab is SQL, got ${tabs[1]}`);
    assert(tabs[2].startsWith('Data'), `third tab is Data, got ${tabs[2]}`);

    // The step trace is what makes the answer auditable.
    const steps = await page.eval(`return document.querySelectorAll('.hood-steps li').length`);
    assertEqual(steps, 4, 'recorded agent steps');
  });

  // The panel has to show how the answer was built, not just the query the
  // agent happened to stop on: every step, each query's own rows, and the one
  // the answer rests on selected to begin with.
  await test('the trace shows every step, and each query can be inspected', async () => {
    const stepText = await page.eval(
      `return [...document.querySelectorAll('.hood-steps li')].map(s => s.textContent)`
    );
    assert(/story scores by hour/.test(stepText[0]), `discovery step should show what it asked for: "${stepText[0]}"`);
    assert(/Ran a Malloy query/.test(stepText[1]), `failed query should still be listed: "${stepText[1]}"`);
    assert(/3 rows/.test(stepText[2]), `a query step should show its row count: "${stepText[2]}"`);

    // A query that errored has no result to offer, so it isn't selectable.
    assertEqual(
      await page.eval(`return document.querySelectorAll('.hood-steps li button').length`),
      2,
      'selectable steps (the two queries that returned rows)'
    );
    assert(
      await page.eval(`return !!document.querySelector('.hood-steps li.failed')`),
      'the failed query is not marked as such'
    );

    // The richest result is selected, not the trailing one-row lookup.
    assertEqual(
      await page.eval(`return document.querySelector('.hood-steps .active').textContent.includes('3 rows')`),
      true,
      'the primary step starts selected'
    );
    assert(
      /by_category/.test(await page.eval(`return document.querySelector('.hood .code').textContent`)),
      'the panel should open on the primary query'
    );
    const openedOn = await page.eval(`return document.querySelector('.interpretation').textContent`);
    assert(
      /governed submission categories/.test(openedOn),
      `the gloss should describe the primary query, got "${openedOn}"`
    );

    // Selecting the other query swaps the Malloy, the SQL and the rows.
    await page.eval(`[...document.querySelectorAll('.hood-steps li button')].at(-1).click(); return 1`);
    await sleep(200);
    const malloy = await page.eval(`return document.querySelector('.hood .code').textContent`);
    assert(/avg_score/.test(malloy), `selecting a step should show its Malloy, got "${malloy}"`);

    // ...and the gloss with them, so the claim always describes the query on show.
    const gloss = await page.eval(`return document.querySelector('.interpretation').textContent`);
    assert(
      /average HN story score/.test(gloss),
      `the gloss should follow the selected step, got "${gloss}"`
    );
    const dataTab = await page.eval(
      `return [...document.querySelectorAll('.hood-tab')].find(t => t.textContent.startsWith('Data')).textContent`
    );
    assertEqual(dataTab, 'Data (1)', 'row count follows the selected step');

    // The chart above the panel keeps showing the result the answer rests on.
    assert(
      await page.eval(`return !!document.querySelector('.chart-card')`),
      'the chart should still be rendered from the primary result'
    );
  });

  await test('copying the answer link confirms it copied', async () => {
    const LINK = `document.querySelector('.msg-actions [aria-label^="Copy a link"]')`;
    // Both answer actions are icon buttons, named only by their accessible label.
    assertEqual(
      await page.eval(`return document.querySelectorAll('.msg-actions .icon-btn').length`),
      2,
      'answer action icons (CSV + permalink)'
    );
    assert(
      await page.eval(`return !!document.querySelector('.msg-actions [aria-label="Download CSV"]')`),
      'no CSV download action next to a result'
    );

    await page.eval(`${LINK}.click()`);
    await page.waitFor(`${LINK}.hasAttribute('data-copied')`, {
      timeoutMs: 3000,
      label: 'copy confirmation',
    });
    const link = await page.eval(`return navigator.clipboard.readText()`);
    assert(/\?q=/.test(link), `clipboard should hold a permalink, got "${link}"`);
  });

  await test('the view stays pinned to the bottom while an answer streams', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('LONG breakdown please')}`);
    await page.waitFor(`document.querySelector('.thread').scrollHeight > document.querySelector('.thread').clientHeight + 50`,
      { label: 'content to overflow' });

    let worst = 0;
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      const s = await page.eval(THREAD);
      if (!s) continue;
      if (s.overflowing) worst = Math.max(worst, s.gap);
      if (!s.streaming) break;
    }
    assert(worst <= 5, `drifted ${worst}px from the bottom while streaming`);
  });

  await test('scrolling up during a stream is respected, not overridden', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('LONG breakdown again')}`);
    await page.waitFor(`document.querySelector('.thread').scrollHeight > document.querySelector('.thread').clientHeight + 200`,
      { label: 'content to overflow' });

    await page.wheel(-600);
    await sleep(400);
    const after = await page.eval(THREAD);
    assert(after.gap > 50, `wheel did not move the view (gap ${after.gap})`);

    await sleep(2500); // content keeps arriving
    const later = await page.eval(THREAD);
    assert(later.st <= after.st + 5, `view was yanked back down (${after.st} -> ${later.st})`);
  });

  await test('returning to the bottom resumes auto-scroll', async () => {
    for (let i = 0; i < 15; i++) await page.wheel(600);
    await sleep(600);
    const back = await page.eval(THREAD);
    assert(back.gap <= 5, `did not reach the bottom (gap ${back.gap})`);

    await sleep(1200);
    const still = await page.eval(THREAD);
    assert(still.gap <= 5, `did not stay pinned after returning (gap ${still.gap})`);
  });

  await test('Stop ends the stream and leaves the partial answer', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('LONG one to interrupt')}`);
    await page.waitFor(`!!document.querySelector('.stop-btn')`);
    await sleep(700);
    await page.eval(`document.querySelector('.stop-btn').click(); return 1`);
    await sleep(600);

    assert(await page.eval(`return !document.querySelector('.stop-btn')`), 'still streaming after Stop');
    assert(await page.eval(`return !!document.querySelector('.stopped')`), 'no "Stopped." marker');
    const len = await page.eval(`return (document.querySelector('.msg.assistant .prose')?.textContent || '').length`);
    assert(len > 0, 'partial answer was discarded');
  });

  await test('a 429 shows a friendly retry message, not a raw error', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('FORCE_429 please')}`);
    await page.waitFor(`!!document.querySelector('.error')`);
    const text = await page.eval(`return document.querySelector('.error').textContent`);
    assert(/try again/i.test(text), `expected a retry hint, got: ${text}`);
    assert(!/429|failed/i.test(text), `leaked a raw status: ${text}`);
    assert(await page.eval(`return !!document.querySelector('.retry-btn')`), 'no retry button');
  });

  // Most questions produce an ad-hoc query with no chart tag, which the Malloy
  // renderer draws as a table. Offering "Chart" and "Table" then shows the same
  // table twice, and sizing the box for a chart leaves it mostly empty.
  await test('an untagged result is one table sized to its rows, with no view toggle', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('Which domains score best?')}`);
    await page.waitFor(`!!document.querySelector('.chart-card .malloy-chart')`, { timeoutMs: 30000 });
    await page.waitFor(`!document.querySelector('.stop-btn')`, { label: 'stream to finish' });
    await sleep(600); // the renderer mounts a frame after the card

    assert(
      await page.eval(`return !document.querySelector('.chart-views')`),
      'untagged result still offers the Chart/Table toggle'
    );
    // …and with no toggle there is no toolbar either, so the table starts at
    // the top of the card instead of under a band of white space.
    const headroom = await page.eval(`
      const card = document.querySelector('.chart-card');
      const box = card.querySelector('.malloy-chart');
      return Math.round(box.getBoundingClientRect().top - card.getBoundingClientRect().top);
    `);
    assert(headroom <= 20, `${headroom}px of empty space above the rendered table`);
    const slack = await page.eval(`
      const box = document.querySelector('.chart-card .malloy-chart');
      const drawn = box.firstElementChild;
      if (!drawn) return 9999;
      return Math.round(box.getBoundingClientRect().height - drawn.getBoundingClientRect().height);
    `);
    assert(slack <= 24, `${slack}px of empty space below the rendered table`);
  });

  // The renderer's own sizing gives every column the same share of the leftover
  // space above its min-content, so a long URL claims the card while a prose
  // title wraps to one word per line and a timestamp splits across two.
  await test('a wide row listing spends its width on the prose column, not the URL', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('WIDE Apple stories please')}`);
    await page.waitFor(`!!document.querySelector('.chart-card .malloy-table.root')`, { timeoutMs: 30000 });
    await page.waitFor(`!document.querySelector('.stop-btn')`, { label: 'stream to finish' });
    await sleep(600); // the renderer settles its column widths a frame later

    const layout = await page.eval(`
      const root = document.querySelector('.chart-card .malloy-table.root');
      const cells = [...root.querySelectorAll('.td.column-cell')].slice(0, 6);
      const lines = (el) => {
        const c = el.querySelector('.cell-content') || el;
        const lh = parseFloat(getComputedStyle(c).lineHeight) || 16;
        return Math.round(c.scrollHeight / lh);
      };
      return {
        overflow: Math.round(root.scrollWidth - root.clientWidth),
        cols: [...root.querySelectorAll('.th.column-cell')].slice(0, 6).map((th, i) => ({
          name: th.textContent.trim(),
          width: Math.round(th.getBoundingClientRect().width),
          lines: cells[i] ? lines(cells[i]) : 0,
        })),
      };
    `);
    const by = (name) => layout.cols.find((c) => c.name === name) || {};
    const names = layout.cols.map((c) => c.name).join(', ');
    assertEqual(layout.cols.length, 6, `column count (${names})`);

    assert(layout.overflow <= 2, `table scrolls horizontally by ${layout.overflow}px`);
    for (const name of ['time', 'score', 'descendants']) {
      assertEqual(by(name).lines, 1, `${name} should stay on one line`);
    }
    const title = by('title');
    const widest = Math.max(...layout.cols.map((c) => c.width));
    assertEqual(title.width, widest, `title should be the widest column (${JSON.stringify(layout.cols)})`);
    assert(title.lines <= 3, `title wrapped to ${title.lines} lines`);
    assert(
      title.width >= by('domain').width * 2,
      `title (${title.width}px) should outweigh domain (${by('domain').width}px)`
    );
  });

  await test('a chart-tagged result keeps the Chart/Table toggle', async () => {
    await page.goto(`${UI}/?q=${encodeURIComponent('CHART story counts by category')}`);
    await page.waitFor(`!!document.querySelector('.chart-views')`, { timeoutMs: 30000 });
    await page.waitFor(`!document.querySelector('.stop-btn')`, { label: 'stream to finish' });
    await page.eval(`
      [...document.querySelectorAll('.chart-view')].find(b => b.textContent === 'Table').click();
    `);
    await sleep(300);
    assert(
      await page.eval(`return !!document.querySelector('.chart-card .hood-table')`),
      'Table view did not show the row table'
    );
  });

  await test('follow-up chips come from the query that answered, not the starters', async () => {
    await page.goto(UI);
    await page.waitFor(`document.querySelectorAll('.empty .chip').length > 0`);
    const target = await page.eval(`
      const c = document.querySelectorAll('.empty .chip')[0];
      const t = c.textContent;
      c.click();
      return t;
    `);
    await page.waitFor(`!!document.querySelector('.follow-ups')`, { timeoutMs: 30000, label: 'follow-ups' });
    const chips = await page.eval(`return [...document.querySelectorAll('.follow-ups .chip')].map(c => c.textContent)`);
    assert(chips.length > 0, 'no follow-up chips');
    assert(chips.length <= 2, `follow-ups should offer at most 2, got ${chips.length}`);
    assert(!chips.includes(target), `follow-ups still offer the asked question: ${target}`);
    // The mock answers every question with `run: stories -> by_category`, so
    // these are the chips that view earns — not the starter list, which is what
    // the UI falls back to when the payload carries none.
    assertEqual(chips.join(' | '), SUGGESTIONS.by_category.join(' | '), 'derived follow-ups');
  });

  await test('New chat clears the thread, the URL and refocuses the composer', async () => {
    await page.eval(`document.querySelector('.new-chat').click(); return 1`);
    await sleep(400);
    assertEqual(await page.eval(`return document.querySelectorAll('.msg').length`), 0, 'messages cleared');
    assertEqual(await page.eval(`return location.search`), '', 'URL query cleared');
    assert(await page.eval(`return !!document.querySelector('.empty')`), 'empty state not restored');
    assertEqual(await page.eval(`return document.activeElement.tagName`), 'TEXTAREA', 'composer focused');
  });

  await test('theme choice survives a reload', async () => {
    await page.goto(UI);
    const before = await page.eval(`return document.documentElement.dataset.theme || 'light'`);
    await page.eval(`[...document.querySelectorAll('.icon-btn')].find(b => b.tagName === 'BUTTON').click(); return 1`);
    await sleep(300);
    const after = await page.eval(`return document.documentElement.dataset.theme`);
    assert(after !== before, `theme did not toggle (stayed ${after})`);

    await page.goto(UI);
    assertEqual(await page.eval(`return document.documentElement.dataset.theme`), after, 'theme after reload');
  });

  await page.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nfailures:');
    for (const f of failed) console.log(`  · ${f.name}: ${f.error}`);
  }
  return failed.length === 0;
}

function cleanup() {
  tearingDown = true;
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

let ok = false;
try {
  ok = await main();
} catch (e) {
  console.error(`\nfatal: ${e.message}`);
} finally {
  cleanup();
}
process.exit(ok ? 0 : 1);
