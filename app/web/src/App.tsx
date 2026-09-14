import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDataset, sendMessage, type ChatTurn, type Dataset, type UnderTheHood as Hood } from './api';
import { Markdown } from './Markdown';
import { HowItWorks } from './HowItWorks';
import { UnderTheHood, stepLabel } from './UnderTheHood';
import { CopyButton } from './CopyButton';
import { DatasetNote } from './DatasetNote';
import { downloadCsv, rowsOf } from './resultView';
// ChartCard is small; it keeps the Vega-backed renderer behind its own lazy
// import so the heavy chunk still stays off the critical path.
import { ChartCard } from './ChartCard';

// Kept in step with HN_MAX_HISTORY / MAX_HISTORY_CHARS in app/server/index.mjs.
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_CHARS = 4000;
const MAX_MESSAGE_CHARS = 4000;

// Answer actions. Icons only — the row sits under every answer, and two words
// of chrome per answer read as noise; the accessible name is on the button.
const iconProps = {
  viewBox: '0 0 24 24',
  width: 15,
  height: 15,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const DownloadIcon = (
  <svg {...iconProps}>
    <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </svg>
);

const LinkIcon = (
  <svg {...iconProps}>
    <path d="M10 13.5a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1.5 1.5" />
    <path d="M14 10.5a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1.5-1.5" />
  </svg>
);

const CREDIBLE_URL = 'https://credibledata.com';
const REPO_URL = 'https://github.com/credibledata/hackernews-demo';

type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  question?: string; // the user question this answer belongs to, for permalinks
  status?: string;
  result?: Hood;
  error?: string;
  streaming?: boolean;
  stopped?: boolean;
};

// The starter questions. Fixed, and each one hinges on a word the model has to
// define before it can answer — which is the thing being demonstrated:
//   best time   → hours are Pacific, "best" is avg score vs. volume, and the model
//                 flags it as correlation rather than posting advice
//   perform     → avg score, and only for domains with enough stories to mean
//                 anything (`top_domains` carries the min-20 guard)
//   engagement  → comments on the whole HN thread, comment rows in this slice,
//                 or score? The model has all three, so the answer has to pick
//                 one and say so
//   successful  → nothing in the model says so; the answer has to pick a score
//                 tier and say which one it picked
const STARTERS = [
  'When is the best time to post?',
  'Which domains perform best on Hacker News?',
  'Do Ask HN or Show HN posts get more engagement?',
  'How rare is a successful story?',
];

type Theme = 'light' | 'dark';

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem('hn-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('hn-theme', theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))] as const;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const nextId = useRef(1);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const threadInner = useRef<HTMLDivElement>(null);
  // `ask` is memoised (the ?q= effect depends on it), so it can't read
  // `messages` from its closure — this ref keeps the history current.
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  // True while the view is pinned to the newest content. Streaming only
  // auto-scrolls when this holds, so scrolling up to read isn't fought.
  const stuck = useRef(true);

  // What the slice covers, for the note under the chips. Cached server-side, so
  // this is a warm read; the empty state renders without waiting on it.
  useEffect(() => {
    fetchDataset().then(setDataset);
  }, []);

  // Grow the composer with its content up to the CSS max-height, then let it
  // scroll — so a long question is fully visible while typing.
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight excludes borders, but box-sizing is border-box — add them
    // back or the box lands 2px short and shows a scrollbar even when empty.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + borders}px`;
  }, [input]);

  const patch = (id: number, fn: (m: Message) => Message) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  // Unpin only on a real user gesture. Deriving this from the `scroll` event
  // would also catch our own programmatic scrolls — and a single large commit
  // (a 320px chart landing at once) would read as "user scrolled up" and
  // silently disable auto-scroll for the rest of the answer.
  // Where we last parked the scroll ourselves. Any scroll event landing
  // somewhere else came from the user.
  const ourScrollTop = useRef(-1);

  const pinToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    ourScrollTop.current = el.scrollTop; // read back: the browser clamps it
  };

  // Distinguishing our own scrolls from the user's by position (rather than by
  // gesture) covers wheel, touch, keyboard and scrollbar drags alike, and can't
  // be fooled by the content growing mid-gesture.
  const onScroll = () => {
    const el = scroller.current;
    if (!el || Math.abs(el.scrollTop - ourScrollTop.current) < 2) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  const scrollDown = (force = false) => {
    if (force) stuck.current = true;
    if (!stuck.current) return;
    requestAnimationFrame(pinToBottom);
  };

  // Content grows asynchronously and in ways no single callback sees — tokens,
  // the lazily-loaded chart, the panel. Watching the content box pins the view
  // for all of them instead of sprinkling scroll calls at each site.
  useEffect(() => {
    const content = threadInner.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stuck.current) pinToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const ask = useCallback(async (text: string) => {
    const q = text.trim();
    if (!q || abort.current) return;
    setBusy(true);
    setInput('');

    // Keep the last question in the URL so any answer can be linked to.
    const url = new URL(location.href);
    url.searchParams.set('q', q);
    history.replaceState(null, '', url);

    const ac = new AbortController();
    abort.current = ac;

    // Mirror the server's cap (HN_MAX_HISTORY / 4000 chars) so a long thread
    // doesn't upload turns the backend will only throw away.
    const priorTurns: ChatTurn[] = messagesRef.current
      .filter((m) => !m.error && m.text)
      .slice(-MAX_HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.text.slice(0, MAX_HISTORY_CHARS) }));

    const userId = nextId.current++;
    const botId = nextId.current++;
    setMessages((ms) => [
      ...ms,
      { id: userId, role: 'user', text: q },
      {
        id: botId,
        role: 'assistant',
        text: '',
        question: q,
        streaming: true,
        status: 'Thinking…',
      },
    ]);
    stuck.current = true;
    scrollDown(true);

    try {
      await sendMessage(
        q,
        priorTurns,
        {
          onToken: (t) => {
            patch(botId, (m) => ({ ...m, text: m.text + t, status: undefined }));
            scrollDown();
          },
          onStatus: (kind, detail) => {
            patch(botId, (m) => ({ ...m, status: `${stepLabel(kind, detail)}…` }));
            scrollDown();
          },
          onResult: (result) => {
            patch(botId, (m) => ({ ...m, result }));
            scrollDown();
          },
          onDone: () => patch(botId, (m) => ({ ...m, streaming: false, status: undefined })),
          onError: (message) =>
            patch(botId, (m) => ({ ...m, streaming: false, status: undefined, error: message })),
        },
        ac.signal
      );
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        patch(botId, (m) => ({
          ...m,
          streaming: false,
          status: undefined,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    } finally {
      if (ac.signal.aborted) {
        patch(botId, (m) => ({ ...m, streaming: false, status: undefined, stopped: true }));
      }
      abort.current = null;
      setBusy(false);
      scrollDown();
    }
  }, []);

  // A ?q= link opens straight into that answer, so results are shareable.
  const autoAsked = useRef(false);
  useEffect(() => {
    if (autoAsked.current) return;
    autoAsked.current = true;
    const q = new URLSearchParams(location.search).get('q');
    if (q?.trim()) ask(q);
  }, [ask]);

  const stop = () => abort.current?.abort();

  const newChat = () => {
    abort.current?.abort();
    setMessages([]);
    setInput('');
    stuck.current = true;
    // Drop ?q= so a reset thread isn't re-asked on reload or re-shared.
    const url = new URL(location.href);
    url.searchParams.delete('q');
    history.replaceState(null, '', url);
    composer.current?.focus();
  };

  // Starter questions the user hasn't already asked, offered under the newest
  // answer.
  const asked = new Set(messages.filter((m) => m.role === 'user').map((m) => m.text));
  const followUps = STARTERS.filter((s) => !asked.has(s)).slice(0, 2);
  const lastMessage = messages.at(-1);

  const linkTo = (question: string) => {
    const url = new URL(location.href);
    url.searchParams.set('q', question);
    return url.toString();
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            Y
          </span>
          <div>
            <div className="title">Ask Hacker News</div>
            <div className="subtitle">
              Plain-English questions, answered from a governed Malloy model
            </div>
            <a className="cta" href={CREDIBLE_URL} target="_blank" rel="noreferrer">
              Built by Credible Data ↗
            </a>
          </div>
        </div>
        <div className="topbar-actions">
          {messages.length > 0 && (
            <button className="how-btn new-chat" onClick={newChat}>
              <span className="how-full">New chat</span>
              <span className="how-short" aria-hidden="true">
                +
              </span>
            </button>
          )}
          <a
            className="source-btn"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="View source on GitHub"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span>Source</span>
          </a>
          <button className="how-btn" onClick={() => setHowOpen(true)} aria-label="How this works">
            <span className="how-full">How this works?</span>
            <span className="how-short" aria-hidden="true">
              ?
            </span>
          </button>
          <button
            className="icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <div className="thread" ref={scroller} onScroll={onScroll}>
        <div className="thread-inner" ref={threadInner}>
        {messages.length === 0 && (
          <div className="empty">
            <h1>What do you want to know about Hacker News?</h1>
            <p>
              Ask in plain English. An agent queries a governed Malloy model through
              its MCP server, so definitions and joins are reused instead of invented
              per prompt.
            </p>
            <DatasetNote dataset={dataset} />
            <div className="examples">
              {STARTERS.map((e) => (
                <button key={e} className="chip" onClick={() => ask(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="avatar" aria-hidden="true">
              {m.role === 'user' ? 'You' : 'HN'}
            </div>
            <div className="bubble">
              {m.status && (
                <div className="status">
                  <span className="status-dot" aria-hidden="true" />
                  {m.status}
                </div>
              )}
              {m.text &&
                (m.role === 'assistant' ? (
                  <div aria-live="polite" aria-busy={m.streaming}>
                    <Markdown>{m.text}</Markdown>
                  </div>
                ) : (
                  <div className="text">{m.text}</div>
                ))}
              {m.streaming && !m.text && !m.status && <div className="status">…</div>}
              {m.stopped && <div className="stopped">Stopped.</div>}
              {m.error && (
                <div className="error" role="alert">
                  <span>⚠ {m.error}</span>
                  {m.question && (
                    <button className="retry-btn" onClick={() => ask(m.question!)}>
                      Try again
                    </button>
                  )}
                </div>
              )}

              {m.result?.data != null && <ChartCard data={m.result.data} />}

              {m.result?.steps?.length ? (
                <UnderTheHood
                  steps={m.result.steps}
                  primary={m.result.primary}
                  cached={m.result.cached}
                />
              ) : null}

              {m.role === 'assistant' && !m.streaming && m.question && !m.error && (
                <div className="msg-actions">
                  {rowsOf(m.result?.data).length > 0 && (
                    <button
                      className="icon-btn"
                      onClick={() => downloadCsv(m.result!.data)}
                      aria-label="Download CSV"
                      title="Download CSV"
                    >
                      {DownloadIcon}
                    </button>
                  )}
                  <CopyButton
                    className="icon-btn"
                    text={linkTo(m.question)}
                    icon={LinkIcon}
                    ariaLabel="Copy a link to this answer"
                  />
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Keep exploring without retyping — only once the thread is settled,
            so the chips don't shift under a streaming answer. */}
        {followUps.length > 0 &&
          lastMessage?.role === 'assistant' &&
          !lastMessage.streaming &&
          !busy && (
            <div className="follow-ups">
              <div className="follow-ups-label">Try next</div>
              <div className="examples">
                {followUps.map((s) => (
                  <button key={s} className="chip" onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          ref={composer}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
          placeholder="Ask about Hacker News data…"
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
          aria-label="Ask a question about Hacker News"
        />
        {busy ? (
          <button type="button" className="stop-btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Ask
          </button>
        )}
        <div className="composer-hint">Enter to send · Shift + Enter for a new line</div>
      </form>

      <HowItWorks open={howOpen} onClose={() => setHowOpen(false)} dataset={dataset} />
    </div>
  );
}
