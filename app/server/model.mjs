// The model source, served to the UI so "How this works" can show the actual
// governed model rather than a prose summary of it that drifts from the file.
//
// Read from disk rather than bundled into the web app: most visitors never open
// the panel, and the file is the same one Publisher serves — the Dockerfile
// copies it to the same place relative to this directory as in a dev checkout.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_PATH = process.env.HN_MODEL_PATH ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package/hn.malloy');

let pending = null;

/** The text of hn.malloy, read once. Throws if it isn't there. */
export function getModelSource() {
  // Cached as the promise, not the result, so concurrent first-hits share one
  // read. A failed read clears it, so a fixed path recovers without a restart.
  pending ??= readFile(MODEL_PATH, 'utf8').catch((e) => {
    pending = null;
    throw e;
  });
  return pending;
}
