// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Enough to drive the UI for the browser tests without pulling in Playwright
// and its browser downloads — CI images already ship Chrome.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  const found = CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No Chrome found. Set CHROME_PATH. Tried:\n  ${CANDIDATES.join('\n  ')}`
    );
  }
  return found;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch headless Chrome with remote debugging and connect to its page target. */
export async function launch({ windowSize = '1000,700' } = {}) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'hn-cdp-'));
  const proc = spawn(
    findChrome(),
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox', // CI containers run as root
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      // Port 0 = let Chrome pick a free one and report it in the profile dir.
      // A fixed port silently attaches to a browser a crashed run left behind,
      // whose emulation state (viewport, permissions) is not the one we set up.
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      `--window-size=${windowSize}`,
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  // Wait for the debugging endpoint to come up and answer.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* not up yet */
    }
  }
  if (!target) {
    proc.kill('SIGKILL');
    throw new Error('Chrome did not expose a page target');
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed'));
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  // A headless page counts as unfocused, and navigator.clipboard rejects with
  // NotAllowedError there — which would make every copy button untestable.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.bringToFront');

  return {
    send,

    /** Evaluate an expression in the page and return its value. */
    async eval(expression) {
      const res = await send('Runtime.evaluate', {
        expression: `(() => { ${expression} })()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.result?.exceptionDetails) {
        throw new Error(`page error: ${res.result.exceptionDetails.text}`);
      }
      return res.result?.result?.value;
    },

    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(600); // let the SPA mount
    },

    /** Poll until `expression` returns truthy, else throw. */
    async waitFor(expression, { timeoutMs = 15000, label = expression } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await this.eval(`return ${expression}`)) return true;
        await sleep(150);
      }
      throw new Error(`timed out waiting for: ${label}`);
    },

    /** A real wheel gesture — dispatching a scroll event would not move the page. */
    wheel(deltaY, { x = 500, y = 300 } = {}) {
      return send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    },

    async close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      proc.kill('SIGKILL');
    },
  };
}
