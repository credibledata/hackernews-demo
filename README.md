# Ask Hacker News — a Malloy + Publisher demo

Ask questions about Hacker News in plain English and get answers backed by a
governed [Malloy](https://malloydata.dev) semantic model, served by the
[Malloy Publisher](https://github.com/malloydata/publisher). An agent composes
queries against the model instead of writing raw SQL, so the numbers come back
consistent with governed definitions instead of inventing business logic per
prompt — and you can see the interpretation, Malloy query, and generated SQL
behind every answer.

There are two ways in, both onto the same model:

1. **A bundled chat UI** — a ChatGPT-style page. Its backend drives an OpenAI model, which
   calls the model's tools over MCP, and the UI renders each answer as a chart
   plus a "how this was computed" card: what the numbers mean, and under it every
   step the agent took — for each query, the Malloy, the SQL it compiled to, and
   the rows it returned.
2. **Direct MCP** — point Claude Code, Codex, Cursor, or any MCP client straight
   at the server and ask in plain English.

Everything is open source (MIT). The data is the public
[`open-index/hacker-news`](https://huggingface.co/datasets/open-index/hacker-news)
dataset (ODC-By).

## How it fits together

```
 Browser ── /            chat UI (React)
         └─ /chat/*  ──►  chat backend ──MCP──► Publisher ──DuckDB──► Parquet
 Agent   ── /mcp     ──────────────────────────►  (same server)
         ── /api/*   ──►  Publisher REST / Explorer
```

- `package/hn.malloy` — the semantic model: two DuckDB-backed sources (`stories`,
  `comments`) with a comments→stories join, documented dimensions/measures, and
  chart-tagged views.
- `prep/build-data.mjs` — builds the curated Parquet slice from Hugging Face.
- `app/server` — an MCP client to Publisher that drives an OpenAI model (`gpt-5.6-luna`).
- `app/web` — the chat UI (`@malloydata/render` for charts).
- `docker/` + `Dockerfile` — one image, one port, fronted by nginx.

## Quick start (Docker)

Needs an OpenAI API key for the chat UI (the MCP path below does not). Copy the
template and fill in your key:

```bash
cp .env.example .env      # then set OPENAI_API_KEY=sk-...
docker compose up --build
```

Docker Compose reads the root `.env` on its own and passes the key into the
container; without it, `docker compose up` stops with `set OPENAI_API_KEY`
instead of starting a broken chat backend. Exporting the var in your shell works
too (`export OPENAI_API_KEY=sk-...`) and takes precedence over `.env`. `.env` is
git-ignored — get the key from
[platform.openai.com/api-keys](https://platform.openai.com/api-keys) and keep it
out of commits.

Open **http://localhost:8080**. The compose file bakes a small 3-month window for a
fast first build; see [Configuring the data window](#configuring-the-data-window)
to change it.

That one container is the whole demo — Publisher, the chat backend, nginx and the
built UI. Nothing else needs to run on the host. In the foreground, Ctrl-C stops
it; started detached (`-d`) it keeps running until:

```bash
docker compose down
```

## Connect an agent over MCP

The Publisher MCP endpoint is the same model the chat UI uses. Point any MCP
client at it:

```bash
# Against the Docker container (or a hosted deploy — swap in your host):
claude mcp add --transport http hn http://localhost:8080/mcp

# Against a bare local Publisher (see "Run locally without Docker"):
claude mcp add --transport http hn http://localhost:4040/mcp
```

Then ask, in plain English:

> *Use the hn tools to find which domains have the highest average score.*

Codex, Cursor, and Claude Desktop connect to the same URL — see Publisher's
[docs/ai-agents.md](https://github.com/malloydata/publisher/blob/main/docs/ai-agents.md)
for per-client config and a stdio bridge.

> The MCP endpoint is unauthenticated and can read any data the model connects to.
> Here that's only public HN data, but put an authenticating gateway in front
> before exposing a deployment beyond a demo.

## What you can ask

The model is built to answer questions like:

- Which domains get the highest average score?
- What are the best hours and days to post for a high score?
- How has Ask HN vs Show HN volume changed over time?
- Who are the most prolific submitters, and the most active commenters?
- Which stories generated the most discussion?
- How rare is a 500+ point story?

The four starter chips in the UI are fixed (`STARTERS` in `app/web/src/App.tsx`)
and each one turns on a word the model has to define first: *best time* (Pacific
hours, and correlation rather than posting advice), *perform* (average score, and
only for domains with at least 20 stories), *engagement* (comments on the whole
HN thread, comment rows in this slice, or score — the model carries all three),
and *successful* (nothing in the model marks a story successful, so the answer
has to pick a score tier and say which). Each answer states the definition it used
— `app/server/interpretation.mjs` derives that line from the Malloy that ran, not
from a second model call — so the point of a semantic layer shows up on the first
click instead of being explained.

## Configuring the data window

`prep/build-data.mjs` reads a configurable lookback window (env vars):

| Var | Default | Meaning |
| --- | --- | --- |
| `HN_MONTHS` | `12` | Months back from `HN_END` |
| `HN_END` | latest available | Last month to include, `YYYY-MM` |
| `HN_TYPES` | `1,2,5` | Item types: 1=story, 2=comment, 5=job |
| `HN_REFRESH_SCORES` | `1` | Re-read scores and comment counts from the HN API; `0` skips it |
| `HN_REFRESH_CONCURRENCY` | `50` | In-flight HN API requests during that refresh |

- **At build time:** `docker build --build-arg HN_MONTHS=6 ...` bakes that window
  into the image.
- **At boot (hybrid):** set `HN_MONTHS`/`HN_END` and `HN_REFETCH=1` on the
  container; if they differ from the baked window, it re-fetches from Hugging Face
  before serving.

A wider window means richer trends and denser comment→story joins, but a larger
image and longer build. Comments whose root story predates the window resolve to a
null root; prep logs the resolution rate so any coverage loss is visible.

### Why the score refresh exists

The Hugging Face dataset records `score` and `descendants` as they were when each
item was ingested — minutes after posting — and never updates them. On a 3-month
slice that left the average story score at 2.3 with a maximum of 368 and not a
single story above 500 points, and reported 39,221 total comments against the
862,656 comment rows actually in the same slice.

Prep therefore re-reads both fields from the HN Firebase API before writing the
Parquet. On that slice: 83,445 items in 146s at concurrency 50, average score
2.3 → 19.8, maximum 368 → 3,158, 570 stories over 500 points, and a comment total
that lands within 0.1% of the comment rows counted independently through the join.

The refresh fails the build if more than 5% of items error, rather than shipping
numbers that look authoritative and are eight times too low. Set
`HN_REFRESH_SCORES=0` to skip it — the slice still builds, with ingest-time scores.

## Run locally without Docker

```bash
# 1. Build a data slice (1 month is quick; the default is 12).
npm install
HN_MONTHS=1 npm run prep

# 2. Serve the model (Publisher: REST + Explorer on :4000, MCP on :4040).
npm run serve

# 3. Chat backend (needs the key: root .env, as in Quick start, or inline).
cd app/server && npm install && npm start
# without a .env: OPENAI_API_KEY=sk-... npm start

# 4. Chat UI (dev server on :5173, proxies /chat to the backend).
cd app/web && npm install && npm run dev
```

Explorer (the no-code visual query builder) is at http://localhost:4000 when
Publisher is running.

## Limiting cost and load

Every chat message runs a model turn plus tool round-trips, so `/chat/message`
is admission-controlled: a per-IP token bucket and a global concurrency cap.
Over either limit the endpoint returns 429 with `Retry-After`, and the UI shows
a "try again in Ns" message rather than an error. Requests are aborted when the
client disconnects (closing the tab or pressing Stop), so an abandoned answer
stops billing instead of running to completion.

| Var | Default | Meaning |
| --- | --- | --- |
| `HN_RATE_BURST` | `5` | Messages one IP can send back-to-back |
| `HN_RATE_PER_SEC` | `0.2` | Sustained per-IP refill (~12/min) |
| `HN_MAX_INFLIGHT` | `8` | Concurrent messages across all clients |
| `HN_MAX_HISTORY` | `10` | Prior turns replayed to the model |
| `HN_MAX_MESSAGE_CHARS` | `4000` | Maximum length of one submitted question |

`/api/` and `/mcp` reach Publisher directly without touching the backend, so
they are limited in nginx instead — otherwise anyone who found them could run
unmetered DuckDB queries. Both return 429 when over the limit. MCP gets more
headroom because one agent turn is several tool calls.

| Var | Default | Meaning |
| --- | --- | --- |
| `HN_API_RATE` | `2r/s` | Sustained per-IP rate for `/api/` |
| `HN_MCP_RATE` | `4r/s` | Sustained per-IP rate for `/mcp` |
| `HN_API_BURST` | `20` | Burst allowance for `/api/` |
| `HN_MCP_BURST` | `40` | Burst allowance for `/mcp` |
| `HN_CONN_LIMIT` | `10` | Concurrent connections per IP to Publisher |

All of these key off the client IP. nginx passes the real peer to the backend in
`X-Forwarded-For` and the backend trusts only the loopback hop, so a spoofed
header can't win a fresh bucket. **If you deploy behind an external load
balancer**, every request arrives from the balancer's address and these become
global limits — configure nginx's `real_ip` module with your balancer's range
first.

Answers to opening questions are cached and replayed, which matters more than it
sounds: nearly every first-time visitor clicks one of the same four starter
chips, and a shared `?q=` link re-asks the same question for everyone who opens
it. Without the cache each of those is a fresh model turn, so cost scales with
visitors rather than with distinct questions. Follow-ups are never cached — the
answer depends on the conversation before it — and the UI marks a replayed
answer `cached` on the "how this was computed" card.

| Var | Default | Meaning |
| --- | --- | --- |
| `HN_ANSWER_TTL_MS` | `3600000` | How long a cached answer stays valid (1h) |
| `HN_ANSWER_CACHE_SIZE` | `200` | Distinct questions kept |
| `HN_METRICS_TOKEN` | unset | If set, `/chat/metrics` requires `?token=` |

`/chat/metrics` returns counters, cache hit rate, and answer latency (p50/p95)
as JSON — enough to tell whether the demo is actually serving during a traffic
spike. Cached replays are counted separately and excluded from the latency
window, so the percentiles still describe what a real answer costs.

The chat UI reads one optional build-time var, `VITE_EXPLORER_URL`. Set it to a
separately-exposed Publisher and each answer gets an "Open in Explorer" link.
Leave it unset in the single-port Docker deploy — Explorer serves its assets
from paths that collide with the UI's.

## Tests

```bash
npm test            # hermetic: prep ETL, rate limiter, metrics, answer cache
npm run test:browser # drives the real UI in headless Chrome against a mock backend
```

Both are hermetic — no API key, no network, no Publisher — so they run in CI
(`.github/workflows/ci.yml`, which also validates the rendered nginx config).

The prep test builds a fixture with known parent chains and asserts the
stories/comments split, the derived `domain`/`category`, and exact root-story
resolution.

The browser tests cover what unit tests can't reach: that the view stays pinned
to the bottom while an answer streams, that scrolling up is *not* overridden,
that returning to the bottom resumes auto-scroll, plus Stop, the `?q=`
permalink, the 429 message, follow-up chips, New chat, theme persistence, and
that a result renders as one table or a chart with a Chart/Table toggle
depending on the query's own tags.
`tests/browser/mock-backend.mjs` replaces the model with a scripted SSE stream,
which is what makes the timing-sensitive assertions reliable. Set `CHROME_PATH`
if Chrome isn't in a standard location.

**Live chat smoke test** (needs a running stack + `OPENAI_API_KEY` on the
backend): asks a real question and checks the agent streams an answer and returns
the Malloy query + SQL behind it.

```bash
# against Docker: HN_CHAT_URL=http://localhost:8080/chat/message npm run smoke
npm run smoke       # against local dev backend on :8787
```

**Chart render check:** with Publisher and the web dev server running, open
`http://localhost:5173/?check` to render a few queries directly through
`@malloydata/render` — a quick visual confirmation the chart path works.

## Repo layout

```
package/            Publisher package: publisher.json, hn.malloy, data/ (baked)
publisher.config.json
.env.example        template for the root .env (OPENAI_API_KEY)
prep/build-data.mjs Node + DuckDB ETL (Hugging Face → curated Parquet)
app/server          chat backend (MCP client + OpenAI tool loop, SSE)
  ratelimit.mjs     per-IP token bucket + global in-flight cap
  metrics.mjs       counters and answer-latency percentiles
  answercache.mjs   TTL+LRU replay of answers to repeated opening questions
  trace.mjs         the "under the hood" trace: the agent's steps, with each
                    query re-run over REST for its SQL and rows
  interpretation.mjs "Interpreted as:" line, derived from the Malloy that ran
app/web             chat UI (Vite + React + @malloydata/render)
  ChartCard.tsx     chart/table switch, CSV download, lazy renderer
  UnderTheHood.tsx  the card behind each answer: the "Interpreted as:" line for
                    the query on show, over its Malloy / SQL / Data
  resultView.tsx    shared table + CSV readers over a Malloy result
  highlight.ts      dependency-free Malloy + SQL tokenizer
  public/           og.png (share card), robots.txt
docker/             nginx.conf.template, entrypoint.sh
Dockerfile          multi-stage: build UI, bake data, serve
tests/              hermetic unit tests + live smoke test
  browser/          headless-Chrome UI tests over a mock backend
.github/workflows   CI: unit + browser tests, UI build, nginx config check
```

## Notes

- The image is ~1.4 GB with a small window (Node, the Publisher server, the vega
  charting bundle, and DuckDB). It scales with the baked data window.
- Times are Pacific (`America/Los_Angeles`), fixed by a `timezone:` statement on
  each source in `package/hn.malloy`, so hour, day-of-week and month buckets are
  the same whatever the host clock says. The Parquet stores UTC instants; the
  conversion happens in the query. Scores are point-in-time snapshots from when
  the dataset was fetched, not live values. There are no user profiles in the
  dataset.
