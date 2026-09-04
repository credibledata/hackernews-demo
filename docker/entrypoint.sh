#!/usr/bin/env bash
# Boot the demo: (optionally) rebuild the data window, then run Publisher, the
# chat backend, and nginx together behind a single port.
set -euo pipefail
cd /app

# ── Hybrid data: re-fetch only if the requested window differs from the baked one.
WANT="${HN_MONTHS:-$BAKED_HN_MONTHS}:${HN_END:-latest}"
HAVE="$(cat package/data/.window 2>/dev/null || echo missing)"
if [ "${HN_REFETCH:-0}" = "1" ] || [ "$WANT" != "$HAVE" ]; then
  echo "[entrypoint] rebuilding data window (want=$WANT have=$HAVE)…"
  HN_OUT=/app/package/data \
  HN_MONTHS="${HN_MONTHS:-$BAKED_HN_MONTHS}" \
  HN_END="${HN_END:-}" \
    node prep/build-data.mjs
else
  echo "[entrypoint] using baked data window ($HAVE)"
fi

# ── Normalize to a versioned + symlink layout so the daily refresh can swap
#    the whole data directory atomically (see prep/refresh.mjs).
if [ ! -L package/data ] && [ -d package/data ]; then
  mv package/data package/data.v0
  ln -s data.v0 package/data
  echo "[entrypoint] data layout: package/data -> data.v0"
fi

# ── Render the nginx config for the platform-provided port, plus the rate
#    limits guarding the Publisher endpoints (tunable like the chat limiter).
PORT="${PORT:-8080}"
sed -e "s/__PORT__/${PORT}/" \
    -e "s|__API_RATE__|${HN_API_RATE:-2r/s}|" \
    -e "s|__MCP_RATE__|${HN_MCP_RATE:-4r/s}|" \
    -e "s/__API_BURST__/${HN_API_BURST:-20}/" \
    -e "s/__MCP_BURST__/${HN_MCP_BURST:-40}/" \
    -e "s/__CONN_LIMIT__/${HN_CONN_LIMIT:-10}/" \
    /app/nginx.conf.template > /etc/nginx/nginx.conf
echo "[entrypoint] nginx will listen on ${PORT}"
echo "[entrypoint] publisher limits: api=${HN_API_RATE:-2r/s} mcp=${HN_MCP_RATE:-4r/s} conn=${HN_CONN_LIMIT:-10}"

# ── Start Publisher (REST 4000, MCP 4040). PUBLISHER_WATCH makes it serve the
#    package in place (symlinked to /app/package) instead of copying it, so the
#    daily refresh's atomic data swap + reload is actually picked up without a
#    restart. Without this, Publisher serves a stale copy and the refresh is a
#    no-op.
PUBLISHER_WATCH="${HN_ENV:-hn}" \
  malloy-publisher --port 4000 --host 127.0.0.1 --config /app/publisher.config.json &
PUB=$!

echo "[entrypoint] waiting for Publisher to report serving…"
for _ in $(seq 1 90); do
  if curl -sf http://127.0.0.1:4000/api/v0/status 2>/dev/null | grep -q '"serving"'; then
    echo "[entrypoint] Publisher serving"; break
  fi
  sleep 2
done

# ── Daily data refresh: rebuild the slice and hot-swap it in, no restart. The
#    ETL is niced so it doesn't steal CPU from serving; a failed run leaves the
#    current data untouched. Disable with HN_REFRESH=0.
#
#    Refresh first, then sleep — a container that restarts more often than the
#    interval (or is stopped between requests) would otherwise never reach its
#    first run and serve the baked window forever. refresh.mjs exits without
#    building when the data it finds is younger than the interval, so a restart
#    loop costs one metadata read rather than a rebuild.
if [ "${HN_REFRESH:-1}" = "1" ]; then
  ( while true; do
      echo "[entrypoint] data refresh: checking…"
      HN_MONTHS="${HN_MONTHS:-$BAKED_HN_MONTHS}" HN_END="${HN_END:-}" \
      HN_REFRESH_INTERVAL="${HN_REFRESH_INTERVAL:-86400}" \
        nice -n 19 node prep/refresh.mjs || echo "[entrypoint] refresh failed; kept current data"
      sleep "${HN_REFRESH_INTERVAL:-86400}"
    done ) &
  REFRESH=$!
  echo "[entrypoint] data refresh every ${HN_REFRESH_INTERVAL:-86400}s (first check now)"
fi

# ── Start the chat backend.
( cd /app/app/server && PORT=8787 node index.mjs ) &
BACK=$!

# ── nginx in the foreground; keep the container alive on whichever process exits.
nginx -g 'daemon off;' &
NGINX=$!

shutdown() { echo "[entrypoint] shutting down"; kill "$PUB" "$BACK" "$NGINX" ${REFRESH:+"$REFRESH"} 2>/dev/null || true; }
trap shutdown TERM INT
wait -n "$PUB" "$BACK" "$NGINX"
shutdown
