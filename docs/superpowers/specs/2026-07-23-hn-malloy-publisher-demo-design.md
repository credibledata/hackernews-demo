# Hacker News + Malloy + Publisher Demo — Design

Date: 2026-07-23
Status: Approved pending spec review

## Goal

A self-contained, hostable demo that shows off Malloy and the Malloy Publisher
(both MIT / open source) on real Hacker News data. The headline experience is
**AI-over-MCP**: ask questions about HN in plain English and get answers that are
right by construction, because the agent composes queries against a governed
Malloy semantic model instead of writing raw SQL.

The demo has two front doors onto the same Publisher MCP server:

1. A **ChatGPT-style web UI** bundled with the demo (its backend drives Claude,
   which calls the MCP tools, and the UI renders answers as real charts plus an
   "under the hood" panel showing the Malloy query and the compiled SQL).
2. **Direct MCP** for any external agent (Claude Code, Codex, Cursor, Claude
   Desktop, …) — connect an MCP client straight to the server and ask in plain
   English.

Everything ships as a Docker image so it can run locally and be hosted on Render
or GCP Cloud Run.

## Data

Source: `open-index/hacker-news` on Hugging Face (ODC-By license). A single flat,
self-referential table of ~49M items (stories, comments, jobs, polls) sharing one
16-column schema, partitioned by month as Parquet (`data/YYYY/YYYY-MM.parquet`),
~12.3 GB total. `by` is a reserved word in DuckDB (quote it); `type` is an integer
enum (1=story, 2=comment, 3=poll, 4=pollopt, 5=job); `deleted`/`dead` are 0/1
integers; `text` is raw HTML; scores are point-in-time snapshots; there are no user
profiles.

12 GB is too large to ship or query snappily, so a prep step builds a curated
local Parquet slice.

### Configurable lookback

The window is configurable, defaulting to the most recent **12 months**. Config is
read from environment variables by the prep script:

- `HN_MONTHS` (default `12`) — how many months back from `HN_END`.
- `HN_END` (default: latest available month in the dataset) — the last month to include.
- `HN_TYPES` (default `1,2,5`) — item types to keep (stories, comments, jobs).

## Data prep pipeline (`prep/build-data.mjs`)

A single Node script using the `duckdb` (Node) package, so the same runtime (Node)
serves both the data prep and the Publisher server — no Python needed in the image.
It runs at Docker build time (to bake the default window) and, in the hybrid path,
optionally at container startup when env overrides the baked default.

Steps, all in DuckDB (`INSTALL httpfs; LOAD httpfs;`), reading
`hf://datasets/open-index/hacker-news/data/YYYY/*.parquet` for the window:

1. **Split by type.** `stories` = items where `type IN (1,5)`; `comments` =
   `type = 2`. Drop `deleted`/`dead` rows. Drop heavy unused columns (`words`,
   `kids`, `parts`, `poll`).
2. **Derive at prep (expensive-once).**
   - `domain`: extracted from `url` (empty for text posts).
   - `category`: `Ask HN` / `Show HN` (title prefix) / `Job` (type 5) / `Link`.
   - `length`: character length of comment `text`.
3. **Resolve `root_story_id` for comments** by walking `parent` chains up to the
   owning story via a DuckDB recursive CTE. This is what enables the real
   comments→stories join. Comments whose root falls before the window resolve to
   NULL (documented limitation; most same-window threads resolve). If the recursive
   pass proves too heavy at scale, fall back to top-level resolution (parent is a
   story) and note the reduced coverage in the run log — never silently drop data.
4. Write `data/stories.parquet` and `data/comments.parquet` (Zstd).

The script logs row counts and the `root_story_id` resolution rate so any coverage
loss is visible, never silent.

## Semantic model (`hn.malloy`)

Two DuckDB-backed sources over the baked Parquet, one join, every source /
dimension / measure / view carrying a `#(doc)` tag — the doc tags are literally
what the MCP agent reads via `malloy_getContext`, so they get first-class attention.

### `stories` (`duckdb.table('data/stories.parquet')`)

- `primary_key: id`
- Dimensions: `category`, `domain`, `author` (`"by"`, quoted), `score`,
  `comment_count` (`descendants`), `post_hour`, `post_dow`, `post_year`,
  `post_month`, plus score tiers.
- Measures: `story_count`, `total_score`, `avg_score`, `max_score`, `avg_comments`.
- Views (chart-tagged): `top_domains`, `score_by_hour` ("best time to post"),
  `score_by_dow`, `by_category`, `stories_per_month`, `ask_vs_show_over_time`,
  `top_authors`, `most_discussed`, `score_distribution`.
- `# dashboard` view `hn_overview`: KPI tiles + monthly trend + top domains +
  hour breakdown + categories.
- `join_many: comments` for story-side commenter analytics.

### `comments` (`duckdb.table('data/comments.parquet')`)

- `primary_key: id`, `join_one: story is stories with root_story_id`.
- Dimensions: `author`, `post_hour`, `length`, `root_story_id`.
- Measures: `comment_count`, `commenter_count`, `avg_length`.
- Views: `top_commenters`, `comments_by_hour`, `avg_length_by_category` (via the join).

### Example questions the demo answers (for the README)

- Which domains get the highest average score on HN?
- What's the best hour and day to post a Show HN?
- How has Show HN vs Ask HN volume changed month over month?
- Who are the most prolific authors, and what's their average score?
- Which stories generated the most discussion?
- What's the score distribution — how rare is a 500+ point story?

## Publisher packaging

The repo root **is** the package: `publisher.json` (name `hacker-news`), `hn.malloy`,
`hn.malloynb` (a short notebook walkthrough), and `data/`. A root
`publisher.config.json` defines one environment (`hn`) with a single package at
location `.` and `connections: []` (the built-in sandboxed `duckdb` connection is
rooted at the package dir automatically). Served via `npx @malloy-publisher/server`:
REST + Explorer UI on **4000**, MCP on **4040**.

## Chat app

### Backend (Node + `@anthropic-ai/sdk`)

- One `/api/chat` endpoint, streaming (SSE).
- Uses Claude (`claude-opus-4-8`) with the **MCP connector**: `mcp_servers`
  pointing at Publisher's MCP endpoint (`http://127.0.0.1:4040/mcp`, internal)
  plus a matching `mcp_toolset` in `tools`, beta header `mcp-client-2025-11-20`.
  `thinking: {type: "adaptive"}`, `output_config: {effort: "high"}`.
- Claude discovers and calls the MCP tools (`malloy_getContext`,
  `malloy_executeQuery`) server-side; the response stream carries `mcp_tool_use`
  blocks. The backend captures the **Malloy query** from each `mcp_tool_use`
  input and the result rows. It obtains the **generated SQL** from the query
  result if the MCP `QueryResult` carries a `sql` field, otherwise via a REST
  `compile` call with `{"includeSql": true}` on the captured query. (Which of the
  two is exercised is an implementation detail resolved in phase 2 against the
  live server; both paths are known to exist.)
- Streams back to the UI: answer text, the Malloy query, the compiled SQL, and the
  result payload (for chart rendering).
- Runtime dependency: `ANTHROPIC_API_KEY`.

### Frontend (Vite + React, ChatGPT-style)

Mirrors the existing `publisher/examples/data-app` stack (Vite + React + MUI +
`@malloydata/render`). Chat thread with streaming replies; each answer renders as a
real chart/table via `@malloydata/render` (the model's views are chart-tagged, so
results render natively) with a collapsible **"Under the hood"** panel showing the
Malloy query and compiled SQL. Served as static assets.

## Docker & hosting

Multi-stage Dockerfile:

- **Builder stage**: runs `prep/build-data.mjs` to bake the default 12-month window
  into `data/`, and builds the React frontend.
- **Runtime stage** (`node`): runs the Publisher server (4000 REST/UI, 4040 MCP),
  the chat backend, and nginx.

`docker/entrypoint.sh` implements the **hybrid** knob: if `HN_MONTHS`/`HN_END`
differ from the baked default, re-run prep on boot before serving; otherwise serve
the baked data immediately.

`docker/nginx.conf` fronts everything on a **single public port** (for Render /
Cloud Run):

- `/` → chat UI (static)
- `/api/*` → chat backend
- `/mcp` → Publisher MCP (4040) — so external agents (Claude Code, Codex, …) can
  connect to the hosted server directly
- `/explore` → Publisher Explorer UI (4000), optional no-code angle

`docker-compose.yml` runs it locally, exposing the single fronted port plus, for
convenience, 4000 and 4040 directly.

Security note for the README: MCP is unauthenticated and the data is public HN
data (low risk), but put an authenticating gateway in front before exposing beyond
a demo.

## Connecting external agents (documented in README)

Two front doors, same model:

1. **Bundled chat UI** — open the app, ask in English.
2. **Direct MCP** — connect any MCP client to the server:
   - Local: `claude mcp add --transport http malloy http://localhost:4040/mcp`
     (Codex / Cursor / Claude Desktop: point at the same URL; see Publisher's
     `docs/ai-agents.md` for per-client config and the stdio bridge).
   - Hosted: point at `https://<host>/mcp`.

## Repo layout

```
hn-demo/
  publisher.json            # package manifest (name: hacker-news)
  hn.malloy                 # the semantic model
  hn.malloynb               # notebook walkthrough
  data/                     # baked by prep — stories.parquet, comments.parquet
  publisher.config.json     # environment "hn" → package location "."
  prep/build-data.mjs       # Node + DuckDB prep, env-configurable
  app/                      # chat app (Vite React frontend + Node backend)
  Dockerfile                # multi-stage: bake data + build UI → serve
  docker-compose.yml        # local run
  docker/entrypoint.sh      # hybrid re-fetch on env override
  docker/nginx.conf         # single-port front (/, /api, /mcp, /explore)
  tests/                    # prep, model-compile, query, container tests
  README.md
```

## Testing (TDD — written first)

1. **Prep test**: run against a tiny fixed 1-month window → assert output columns,
   non-zero rows, and a high `root_story_id` resolution rate.
2. **Model compile test**: compile `hn.malloy` (via the Malloy compiler / Publisher
   `malloy_compile`) → no diagnostics.
3. **Query smoke tests**: a handful of `run:` queries (`by_category`, `top_domains`,
   a joined comment view) return expected shapes / non-empty rows.
4. **Container test**: build image → `curl /api/v0/status` returns `serving` → a
   REST query returns rows → nginx serves `/mcp` and `/`.

## Build phases

1. Package + Publisher serving (model queryable via Explorer/MCP; direct-MCP works).
2. Chat agent backend + React UI.
3. Docker + single-port hosting front.

## Non-goals (YAGNI)

- No auth / multi-tenant / user accounts (public data, demo scope).
- No full-dataset ingestion; the window is deliberately bounded and configurable.
- No pluggable LLM abstraction (Claude only).
- No thread-text reconstruction beyond `root_story_id` resolution.
