// SSE client for the chat backend. Streams answer tokens and the final
// "under the hood" payload back to the caller via callbacks.

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type UnderTheHood = {
  malloyQuery: string;
  sql: string | null;
  // Malloy result payload for <MalloyChart>; shape is a malloy-interfaces Result.
  data: unknown | null;
  // True when the backend replayed a previously computed answer for this
  // question rather than running the agent again.
  cached?: boolean;
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
export type Dataset = { stories: number; comments: number; from: string; to: string };

export type Starter = { suggestions: string[]; dataset: Dataset | null };

/** The empty state's contents; degrades to empty on any failure so the UI can fall back. */
export async function fetchStarter(): Promise<Starter> {
  const empty: Starter = { suggestions: [], dataset: null };
  try {
    const res = await fetch('/chat/starter');
    if (!res.ok) return empty;
    const body = await res.json();
    return {
      suggestions: Array.isArray(body.suggestions)
        ? body.suggestions.filter((s: unknown) => typeof s === 'string')
        : [],
      dataset: body.dataset?.stories ? body.dataset : null,
    };
  } catch {
    return empty;
  }
}

export async function sendMessage(
  message: string,
  history: ChatTurn[],
  handlers: ChatHandlers,
  signal?: AbortSignal
): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/chat/message', {
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
