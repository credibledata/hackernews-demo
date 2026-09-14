// SSE client for the chat backend. Streams answer tokens and the final
// "under the hood" payload back to the caller via callbacks.

import { appUrl } from './appUrl';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

// One tool call the agent made. `detail` is the Malloy for a query step and the
// tool name for anything else; `argument` is what a non-query call asked for.
// A query step that ran carries its own SQL and rows, so any step in the trace
// can be inspected — not just the one the answer rests on.
export type Step = {
  kind: 'query' | 'tool';
  detail: string;
  argument?: string;
  ok: boolean;
  sql?: string | null;
  data?: unknown | null;
  rows?: number;
  interpretation?: string;
};

export type UnderTheHood = {
  malloyQuery: string;
  sql: string | null;
  // Malloy result payload for <MalloyChart>; shape is a malloy-interfaces Result.
  data: unknown | null;
  // Every step behind the answer, and the index of the one the fields above
  // repeat — the result the chart and the CSV download are built from.
  steps: Step[];
  primary: number;
  // True when the backend replayed a previously computed answer for this
  // question rather than running the agent again.
  cached?: boolean;
  // Deterministic explanation of the governed semantics used by the query.
  interpretation?: string;
  // Two questions adjacent to this query in the model, for the "Try next" row.
  // Empty when the query matched nothing the model can follow up on.
  followUps?: string[];
};

export type ChatHandlers = {
  onToken: (text: string) => void;
  onStatus: (kind: string, detail: string) => void;
  onResult: (result: UnderTheHood) => void;
  onDone: () => void;
  onError: (message: string) => void;
};

// What the data slice covers. `from`/`to` are ISO timestamps of the first and
// last story loaded.
export type Dataset = {
  stories: number;
  comments: number;
  from: string;
  to: string;
  refreshedAt?: string;
  scoresRefreshed?: boolean;
  /** How far back the live score refresh reached, in days; null if unbounded. */
  scoreRefreshDays?: number | null;
  /** Width of the slice in months — the archive itself goes back to 2006. */
  windowMonths?: number | null;
};

/** Scope of the loaded slice; null on any failure, so the note is simply omitted. */
export async function fetchDataset(): Promise<Dataset | null> {
  try {
    const res = await fetch(appUrl('/chat/dataset'));
    if (!res.ok) return null;
    const body = await res.json();
    return body.dataset?.stories ? body.dataset : null;
  } catch {
    return null;
  }
}

/**
 * The Malloy model source, for the "How this works" panel. Throws rather than
 * returning null: the panel is opened deliberately, so a reader who asked to
 * see the model needs to be told it couldn't be loaded, not shown a blank.
 */
export async function fetchModelSource(): Promise<string> {
  const res = await fetch(appUrl('/chat/model'));
  if (!res.ok) throw new Error(`model source unavailable (${res.status})`);
  const body = await res.json();
  if (typeof body.text !== 'string' || !body.text) throw new Error('model source was empty');
  return body.text;
}

export async function sendMessage(
  message: string,
  history: ChatTurn[],
  handlers: ChatHandlers,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(appUrl('/chat/message'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, history }),
      signal,
    });
  } catch (e) {
    // An abort is the user pressing Stop, not a failure worth reporting.
    if ((e as Error)?.name === 'AbortError') return;
    handlers.onError("Couldn't reach the server. Check your connection and try again.");
    return;
  }

  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const wait = Number(body.retryAfterSec) || 10;
    handlers.onError(
      body.reason === 'busy'
        ? `Lots of traffic right now — every question runs a real query. Try again in about ${wait}s.`
        : `You're asking faster than the demo can keep up. Try again in about ${wait}s.`
    );
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError(
      res.status >= 500
        ? 'The server had a problem answering that. Try again in a moment.'
        : `Request failed (${res.status})`
    );
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (event: string, data: string) => {
    let payload: any = {};
    try {
      payload = JSON.parse(data);
    } catch {
      /* ignore malformed */
    }
    switch (event) {
      case 'token':
        handlers.onToken(payload.text ?? '');
        break;
      case 'status':
        handlers.onStatus(payload.kind ?? '', payload.detail ?? '');
        break;
      case 'result':
        handlers.onResult(payload);
        break;
      case 'done':
        handlers.onDone();
        break;
      case 'error':
        handlers.onError(payload.message ?? 'Unknown error');
        break;
    }
  };

  // Parse the SSE frames: blocks separated by a blank line, each with
  // `event:` and `data:` lines.
  while (true) {
    let value: Uint8Array | undefined;
    let done: boolean;
    try {
      ({ value, done } = await reader.read());
    } catch (e) {
      // Aborting mid-stream rejects the pending read; that's a Stop, not an error.
      if ((e as Error)?.name === 'AbortError') return;
      throw e;
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) dispatch(event, dataLines.join('\n'));
    }
  }
}
