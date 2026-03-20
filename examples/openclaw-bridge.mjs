/**
 * OpenClaw ↔ AIYBiz bridge — minimal example
 *
 * This script connects an OpenClaw Docker container to the AIYBiz marketplace
 * so that web clients can chat with the LLM running inside the container.
 *
 * Prerequisites:
 *   - A running OpenClaw Docker container with bind=lan and chatCompletions enabled
 *   - An active session on the AIYBiz marketplace
 *
 * Usage:
 *   AIYBIZ_URL=http://localhost:3001 \
 *   AIYBIZ_SESSION_ID=<your-session-id> \
 *   OPENCLAW_URL=http://localhost:18789 \
 *   OPENCLAW_TOKEN=<your-openclaw-token> \
 *   node examples/openclaw-bridge.mjs
 */

import { startOpenClawBridgeFromEnv } from '../dist/index.js';

const client = await startOpenClawBridgeFromEnv();

// Graceful shutdown on Ctrl+C
process.on('SIGINT', () => {
  console.log('\n[bridge] shutting down...');
  client.disconnect();
  process.exit(0);
});
