#!/bin/bash
# deploy-openclaw.sh — One-shot deployment of an OpenClaw agent on AIYBiz
#
# Usage:
#   chmod +x examples/deploy-openclaw.sh
#   ./examples/deploy-openclaw.sh

set -e

# ─── Configuration ──────────────────────────────────────────────────────────

# AIYBiz platform
export AIYBIZ_URL="${AIYBIZ_URL:-http://localhost:3001}"
export AIYBIZ_SESSION_ID="${AIYBIZ_SESSION_ID:?Please set AIYBIZ_SESSION_ID}"
export AIYBIZ_TOKEN="${AIYBIZ_TOKEN:-placeholder}"

# Docker container
export OPENCLAW_CONTAINER="${OPENCLAW_CONTAINER:-openclaw-agent}"
export OPENCLAW_HOST_PORT="${OPENCLAW_HOST_PORT:-18789}"
export OPENCLAW_IMAGE="${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:main-slim}"

# OpenClaw gateway auth (auto-generated if not set)
export OPENCLAW_TOKEN="${OPENCLAW_TOKEN:-$(openssl rand -hex 24)}"

# LLM provider (Moonshot / Kimi K2.5 by default)
export OPENCLAW_PROVIDER_NAME="${OPENCLAW_PROVIDER_NAME:-moonshot}"
export OPENCLAW_PROVIDER_URL="${OPENCLAW_PROVIDER_URL:-https://api.moonshot.ai/v1}"
export OPENCLAW_PROVIDER_KEY="${OPENCLAW_PROVIDER_KEY:?Please set OPENCLAW_PROVIDER_KEY}"
export OPENCLAW_PROVIDER_API="${OPENCLAW_PROVIDER_API:-openai-completions}"
export OPENCLAW_MODEL="${OPENCLAW_MODEL:-moonshot/kimi-k2.5}"
export OPENCLAW_MODEL_ID="${OPENCLAW_MODEL_ID:-kimi-k2.5}"
export OPENCLAW_MODEL_NAME="${OPENCLAW_MODEL_NAME:-Kimi K2.5}"

# Agent system prompt
export OPENCLAW_SYSTEM="${OPENCLAW_SYSTEM:-You are a helpful AI assistant on the AIYBiz marketplace.}"

# ─── Deploy ─────────────────────────────────────────────────────────────────

echo "=== AIYBiz OpenClaw Deployment ==="
echo "Session:   $AIYBIZ_SESSION_ID"
echo "Container: $OPENCLAW_CONTAINER (port $OPENCLAW_HOST_PORT)"
echo "Model:     $OPENCLAW_MODEL"
echo ""

node "$(dirname "$0")/../dist/cli.js" deploy-openclaw
