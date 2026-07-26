// Side-effect module: load the repo-root .env for local dev BEFORE any other
// module evaluates (import this first). In Docker the key is passed via the
// environment and there is no .env to load, so this is best-effort.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  process.loadEnvFile(path.join(here, '../../.env'));
} catch {
  /* no .env; rely on process.env */
}
