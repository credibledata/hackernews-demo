// URL for one of the container's own endpoints (/chat, /api, /mcp), honouring
// the base path the UI was built with.
//
// Vite rewrites asset URLs for `base` on its own, but these endpoints are
// fetched at runtime, so they need the prefix applied here. Deployments that
// serve the demo under a path — behind a load balancer shared with other apps,
// say — build with HN_BASE_PATH set and the browser then addresses
// /<prefix>/chat/message; the container itself still sees /chat/message,
// because whatever strips the prefix on the way in is the same thing that
// added it. At the default base of "/" this is the identity function.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function appUrl(path: string): string {
  return `${BASE}${path}`;
}
