/**
 * OpenClaw ↔ aiybiz bridge.
 *
 * This connects an aiybiz session to an OpenClaw gateway so that
 * messages sent by a web client are answered by the LLM running in OpenClaw.
 *
 * Usage (env vars):
 *   AIYBIZ_URL          aiybiz API URL, e.g. http://localhost:3001
 *   AIYBIZ_SESSION_ID   session ID from the marketplace
 *   AIYBIZ_TOKEN        instance token (optional while auth is disabled)
 *   OPENCLAW_URL        OpenClaw gateway URL, e.g. http://localhost:18789
 *   OPENCLAW_TOKEN      OpenClaw gateway auth token
 *   OPENCLAW_AGENT_ID   OpenClaw agent ID (default: main)
 *   OPENCLAW_SYSTEM     System prompt (optional)
 */

import { AiybizClient } from '../client.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import type { WsMessage } from '../types.js';

const log = (msg: string) => console.log(`[aiybiz:bridge] ${new Date().toISOString()} ${msg}`);
const logErr = (msg: string) => console.error(`[aiybiz:bridge] ${new Date().toISOString()} ERROR ${msg}`);

export interface OpenClawBridgeOptions {
  /** aiybiz config */
  marketplaceUrl: string;
  sessionId: string;
  instanceToken?: string;
  /** OpenClaw config */
  openclawUrl: string;
  openclawToken: string;
  openclawAgentId?: string;
  systemPrompt?: string;
  /** Max tokens per reply (default: 2048) */
  maxTokens?: number;
  /**
   * Interval in ms to check OpenClaw health and pulse status to the marketplace.
   * Set to 0 to disable. Default: 120000 (2 min).
   */
  healthCheckIntervalMs?: number;
}

/**
 * Start the bridge: connects aiybiz client + OpenClaw adapter, wires messages.
 * Returns the connected AiybizClient (for lifecycle management).
 */
export async function startOpenClawBridge(opts: OpenClawBridgeOptions): Promise<AiybizClient> {
  log(`starting bridge: session=${opts.sessionId}`);
  log(`aiybiz: ${opts.marketplaceUrl}`);
  log(`openclaw: ${opts.openclawUrl} agent=${opts.openclawAgentId ?? 'main'}`);

  const client = new AiybizClient({
    marketplaceUrl: opts.marketplaceUrl,
    sessionId: opts.sessionId,
    instanceToken: opts.instanceToken ?? 'placeholder',
    capabilities: ['chat', 'llm'],
  });

  const openclaw = new OpenClawAdapter({
    gatewayUrl: opts.openclawUrl,
    token: opts.openclawToken,
    agentId: opts.openclawAgentId ?? 'main',
    systemPrompt: opts.systemPrompt,
    maxTokens: opts.maxTokens ?? 2048,
  });

  client.on('connect', () => {
    log(`connected to aiybiz marketplace (session=${opts.sessionId})`);
    client.pulse('Agent is online and ready.', { sessionId: opts.sessionId });
  });

  client.on('disconnect', (code, reason) => {
    log(`disconnected from aiybiz (code=${code} reason=${reason || 'none'})`);
  });

  client.on('reconnecting', (attempt, delay) => {
    log(`reconnecting to aiybiz... attempt=${attempt} delay=${delay}ms`);
  });

  client.on('error', (err) => {
    logErr(`aiybiz client error: ${err.message}`);
  });

  client.on('message', async (msg: WsMessage) => {
    log(`received message type=${msg.type} from=${msg.from ?? 'unknown'}`);

    if (msg.type !== 'message') {
      log(`ignoring non-message type: ${msg.type}`);
      return;
    }

    const userText = msg.content?.trim();
    if (!userText) {
      log('ignoring empty message');
      return;
    }

    // Send a "thinking" pulse immediately so the client knows we're processing
    client.pulse('⏳ Processing...', { processing: true });
    log(`forwarding to OpenClaw: ${userText.slice(0, 100)}`);

    try {
      const reply = await openclaw.chat(opts.sessionId, userText);
      client.pulse(reply);
      log(`reply sent to aiybiz (${reply.length} chars)`);
    } catch (err) {
      const errMsg = (err as Error).message;
      logErr(`openclaw error: ${errMsg}`);
      client.pulse(`❌ Error: ${errMsg}`);
    }
  });

  log('connecting to aiybiz marketplace...');
  await client.connect();
  log('bridge is active — waiting for client messages');

  // Periodic health check: ping OpenClaw and pulse the real status
  const healthIntervalMs = opts.healthCheckIntervalMs ?? 120000;
  if (healthIntervalMs > 0) {
    const checkHealth = async () => {
      if (!client.isConnected) return;
      try {
        const res = await fetch(opts.openclawUrl, { signal: AbortSignal.timeout(5000) });
        if (res.ok || res.status < 500) {
          client.pulse('✅ Agent is up and ready.', { status: 'ok', openclawUrl: opts.openclawUrl });
        } else {
          client.pulse(`⚠️ Agent degraded (HTTP ${res.status}).`, { status: 'degraded' });
        }
      } catch (err) {
        client.pulse('❌ Agent unreachable — OpenClaw container may be down.', { status: 'error', error: (err as Error).message });
      }
    };

    const healthTimer = setInterval(checkHealth, healthIntervalMs);
    // Prevent the timer from keeping the process alive if the bridge is stopped
    if (healthTimer.unref) healthTimer.unref();

    client.on('disconnect', () => clearInterval(healthTimer));
  }

  return client;
}

/**
 * Start the bridge from environment variables.
 * Call this when using the bridge as a standalone process.
 */
export async function startOpenClawBridgeFromEnv(): Promise<AiybizClient> {
  const required = {
    AIYBIZ_URL: process.env.AIYBIZ_URL,
    AIYBIZ_SESSION_ID: process.env.AIYBIZ_SESSION_ID,
    OPENCLAW_URL: process.env.OPENCLAW_URL,
    OPENCLAW_TOKEN: process.env.OPENCLAW_TOKEN,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Set them before starting the bridge.\n' +
      'Required: AIYBIZ_URL, AIYBIZ_SESSION_ID, OPENCLAW_URL, OPENCLAW_TOKEN\n' +
      'Optional: AIYBIZ_TOKEN, OPENCLAW_AGENT_ID, OPENCLAW_SYSTEM, OPENCLAW_MAX_TOKENS',
    );
  }

  return startOpenClawBridge({
    marketplaceUrl: process.env.AIYBIZ_URL!,
    sessionId: process.env.AIYBIZ_SESSION_ID!,
    instanceToken: process.env.AIYBIZ_TOKEN,
    openclawUrl: process.env.OPENCLAW_URL!,
    openclawToken: process.env.OPENCLAW_TOKEN!,
    openclawAgentId: process.env.OPENCLAW_AGENT_ID ?? 'main',
    systemPrompt: process.env.OPENCLAW_SYSTEM,
    maxTokens: process.env.OPENCLAW_MAX_TOKENS ? parseInt(process.env.OPENCLAW_MAX_TOKENS, 10) : 2048,
    healthCheckIntervalMs: process.env.OPENCLAW_HEALTH_INTERVAL_MS ? parseInt(process.env.OPENCLAW_HEALTH_INTERVAL_MS, 10) : 120000,
  });
}
