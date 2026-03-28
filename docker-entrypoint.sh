#!/bin/bash
set -e

# ─── Token ────────────────────────────────────────────────────────────────────
# Generate a token if not provided via env var.
# Both write-openclaw-config and start-embedded will read OPENCLAW_TOKEN.
if [ -z "$OPENCLAW_TOKEN" ]; then
  export OPENCLAW_TOKEN=$(node -e "const {randomBytes}=require('crypto');process.stdout.write(randomBytes(24).toString('hex'))")
  echo "[entrypoint] Generated OPENCLAW_TOKEN"
fi

echo "[entrypoint] AIYBiz Embedded Agent starting..."
echo "[entrypoint]   session : ${AIYBIZ_SESSION_ID}"
echo "[entrypoint]   model   : ${OPENCLAW_MODEL}"
echo "[entrypoint]   push    : http://127.0.0.1:${AIYBIZ_PUSH_PORT:-3099}"

# ─── Write OpenClaw config ────────────────────────────────────────────────────
# Write openclaw.json BEFORE starting OpenClaw so it picks it up on first boot.
# No container restart needed.
aiybiz write-openclaw-config

# ─── Start OpenClaw ───────────────────────────────────────────────────────────
echo "[entrypoint] Starting OpenClaw gateway..."
node /app/openclaw.mjs gateway --allow-unconfigured &
OPENCLAW_PID=$!

# ─── Graceful shutdown ────────────────────────────────────────────────────────
_shutdown() {
  echo "[entrypoint] Shutting down..."
  kill "$OPENCLAW_PID" 2>/dev/null || true
  exit 0
}
trap _shutdown SIGTERM SIGINT

# ─── Start aiybiz bridge ──────────────────────────────────────────────────────
# start-embedded waits for OpenClaw to be ready, connects to the marketplace,
# and starts the internal push server.
echo "[entrypoint] Starting aiybiz bridge..."
aiybiz start-embedded

# If bridge exits, stop OpenClaw too
kill "$OPENCLAW_PID" 2>/dev/null || true
