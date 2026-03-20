import { parseArgs } from 'util';
import { resolve } from 'path';
import { resolveConfig } from './config';
import { AiybizClient } from './client';
import { startOpenClawBridgeFromEnv } from './bridge/openclaw-bridge';
import { launchOpenClawContainer, setupOpenClawContainer } from './setup/openclaw';
import type { WsMessage } from './types';

/* eslint-disable @typescript-eslint/no-require-imports */
declare const require: NodeRequire;

const log = (msg: string) => console.log(`[aiybiz:cli] ${new Date().toISOString()} ${msg}`);
const logErr = (msg: string) => console.error(`[aiybiz:cli] ${new Date().toISOString()} ERROR ${msg}`);

function printHelp() {
  console.log(`
aiybiz — AIYBiz SDK CLI

Usage:
  aiybiz start --handler <path> [options]
  aiybiz start-openclaw [options]
  aiybiz deploy-openclaw [options]
  aiybiz check [options]

Commands:
  start            Connect to the marketplace and forward messages to your handler
  start-openclaw   Start the OpenClaw bridge (reads env vars)
  deploy-openclaw  Launch + configure an OpenClaw Docker container, then start bridge
  check            Validate config (dry run, no connection)

Options:
  -c, --config <path>    Path to aiybiz.config.json (default: ./aiybiz.config.json)
  -H, --handler <path>   Path to handler module (required for start)
  -h, --help             Show this help

Handler module:
  Must export a default function: (msg, client) => void | Promise<void>

  // handler.js
  module.exports = async function(msg, client) {
    client.send({ type: 'message', to: msg.from, content: 'Hello!' });
  };

Environment variables (common):
  AIYBIZ_URL              Marketplace base URL (e.g. http://localhost:3001)
  AIYBIZ_SESSION_ID       Session ID provisioned by the marketplace
  AIYBIZ_TOKEN            Instance token provisioned by the marketplace
  AIYBIZ_CAPABILITIES     Comma-separated capabilities (e.g. chat,files)
  AIYBIZ_HEARTBEAT_INTERVAL  Heartbeat interval in ms (default: 30000)
  AIYBIZ_RECONNECT_DELAY     Initial reconnect delay in ms (default: 1000)

Environment variables (start-openclaw / deploy-openclaw):
  OPENCLAW_URL            OpenClaw gateway URL (e.g. http://localhost:18789)
  OPENCLAW_TOKEN          OpenClaw gateway auth token
  OPENCLAW_AGENT_ID       OpenClaw agent ID (default: main)
  OPENCLAW_SYSTEM         System prompt for the LLM
  OPENCLAW_MAX_TOKENS     Max tokens per reply (default: 2048)

Environment variables (deploy-openclaw only):
  OPENCLAW_CONTAINER      Docker container name (default: openclaw-agent)
  OPENCLAW_HOST_PORT      Host port to map to gateway (default: 18789)
  OPENCLAW_IMAGE          Docker image (default: ghcr.io/openclaw/openclaw:main-slim)
  OPENCLAW_PROVIDER_NAME  LLM provider name (e.g. moonshot)
  OPENCLAW_PROVIDER_URL   LLM provider base URL
  OPENCLAW_PROVIDER_KEY   LLM provider API key
  OPENCLAW_PROVIDER_API   Provider API type (e.g. openai-completions)
  OPENCLAW_MODEL          Default model (e.g. moonshot/kimi-k2.5)
  OPENCLAW_MODEL_ID       Model ID within provider (e.g. kimi-k2.5)
  OPENCLAW_MODEL_NAME     Model display name (e.g. Kimi K2.5)
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      handler: { type: 'string', short: 'H' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    args: process.argv.slice(2),
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const command = positionals[0] ?? 'start';

  if (command === 'check') {
    const config = resolveConfig({}, values.config);
    console.log('Config OK:');
    console.log(`  marketplaceUrl  : ${config.marketplaceUrl}`);
    console.log(`  sessionId       : ${config.sessionId}`);
    console.log(`  instanceToken   : ${config.instanceToken.slice(0, 8)}...`);
    console.log(`  capabilities    : ${(config.capabilities ?? []).join(', ') || '(none)'}`);
    process.exit(0);
  }

  if (command === 'start') {
    if (!values.handler) {
      logErr('--handler <path> is required for the start command');
      logErr('Run aiybiz --help for usage.');
      process.exit(1);
    }

    const handlerPath = resolve(values.handler);
    let handlerFn: (msg: WsMessage, client: AiybizClient) => void | Promise<void>;
    try {
      const mod = require(handlerPath) as unknown;
      handlerFn = typeof mod === 'function' ? (mod as typeof handlerFn) : (mod as Record<string, unknown>)?.default as typeof handlerFn;
      if (typeof handlerFn !== 'function') throw new Error('No default function export found');
    } catch (e) {
      logErr(`failed to load handler at ${handlerPath}: ${(e as Error).message}`);
      process.exit(1);
    }

    const config = resolveConfig({}, values.config);
    log(`config resolved: url=${config.marketplaceUrl} session=${config.sessionId}`);
    const client = new AiybizClient(config);

    client.on('connect', () => log('connected to marketplace'));
    client.on('disconnect', (code, reason) =>
      log(`disconnected (code=${code} reason=${reason || 'none'})`),
    );
    client.on('reconnecting', (attempt, delay) =>
      log(`reconnecting... attempt=${attempt} delay=${delay}ms`),
    );
    client.on('error', (err) => logErr(`client error: ${err.message}`));
    client.on('message', async (msg: WsMessage) => {
      log(`message received type=${msg.type} from=${msg.from ?? 'unknown'}`);
      try {
        await handlerFn(msg, client);
      } catch (err) {
        logErr(`handler error: ${(err as Error).message}`);
      }
    });

    const shutdown = () => {
      log('shutting down...');
      client.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    log(`connecting to marketplace: ${config.marketplaceUrl}`);
    await client.connect();
    log(`ready — handler: ${handlerPath}`);
    return;
  }

  // ── start-openclaw ──────────────────────────────────────────────────────────
  if (command === 'start-openclaw') {
    log('command=start-openclaw');
    log(`AIYBIZ_URL=${process.env.AIYBIZ_URL ?? '(not set)'}`);
    log(`AIYBIZ_SESSION_ID=${process.env.AIYBIZ_SESSION_ID ?? '(not set)'}`);
    log(`OPENCLAW_URL=${process.env.OPENCLAW_URL ?? '(not set)'}`);
    log(`OPENCLAW_AGENT_ID=${process.env.OPENCLAW_AGENT_ID ?? 'main'}`);

    let client: AiybizClient;
    try {
      client = await startOpenClawBridgeFromEnv();
    } catch (err) {
      logErr((err as Error).message);
      process.exit(1);
    }

    const shutdown = () => {
      log('shutting down bridge...');
      client.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  // ── deploy-openclaw ─────────────────────────────────────────────────────────
  if (command === 'deploy-openclaw') {
    log('command=deploy-openclaw');

    const containerName = process.env.OPENCLAW_CONTAINER ?? 'openclaw-agent';
    const hostPort = parseInt(process.env.OPENCLAW_HOST_PORT ?? '18789', 10);
    const image = process.env.OPENCLAW_IMAGE ?? 'ghcr.io/openclaw/openclaw:main-slim';
    const token = process.env.OPENCLAW_TOKEN ?? (() => {
      // Auto-generate a token if not provided
      const { randomBytes } = require('crypto') as typeof import('crypto');
      return randomBytes(24).toString('hex');
    })();

    const providerName = process.env.OPENCLAW_PROVIDER_NAME;
    const providerUrl = process.env.OPENCLAW_PROVIDER_URL;
    const providerKey = process.env.OPENCLAW_PROVIDER_KEY;
    const providerApi = process.env.OPENCLAW_PROVIDER_API ?? 'openai-completions';
    const modelFull = process.env.OPENCLAW_MODEL; // e.g. moonshot/kimi-k2.5
    const modelId = process.env.OPENCLAW_MODEL_ID; // e.g. kimi-k2.5
    const modelName = process.env.OPENCLAW_MODEL_NAME ?? modelId ?? 'Default Model';

    if (!providerName || !providerUrl || !providerKey || !modelFull || !modelId) {
      logErr(
        'deploy-openclaw requires: OPENCLAW_PROVIDER_NAME, OPENCLAW_PROVIDER_URL, ' +
        'OPENCLAW_PROVIDER_KEY, OPENCLAW_MODEL, OPENCLAW_MODEL_ID',
      );
      process.exit(1);
    }

    // Step 1: Launch container
    log(`step 1/3: launching Docker container "${containerName}" on port ${hostPort}`);
    try {
      launchOpenClawContainer({ image, name: containerName, hostPort });
    } catch (err) {
      logErr(`failed to launch container: ${(err as Error).message}`);
      process.exit(1);
    }

    // Step 2: Configure OpenClaw
    log(`step 2/3: configuring OpenClaw (model=${modelFull})`);
    const apiKeyEnvVar = `${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    let gatewayUrl: string;
    try {
      gatewayUrl = await setupOpenClawContainer({
        container: containerName,
        token,
        providerEnv: { [apiKeyEnvVar]: providerKey },
        providerConfig: {
          name: providerName,
          baseUrl: providerUrl,
          apiKeyEnvVar,
          api: providerApi,
          defaultModel: modelFull,
          modelId,
          modelName,
        },
      });
    } catch (err) {
      logErr(`failed to configure OpenClaw: ${(err as Error).message}`);
      process.exit(1);
    }

    log(`gateway ready at ${gatewayUrl}`);
    log(`OPENCLAW_TOKEN for this container: ${token}`);

    // Step 3: Start bridge
    log('step 3/3: starting aiybiz bridge');

    // Set env vars for bridge
    process.env.OPENCLAW_URL = gatewayUrl;
    process.env.OPENCLAW_TOKEN = token;

    let client: AiybizClient;
    try {
      client = await startOpenClawBridgeFromEnv();
    } catch (err) {
      logErr(`failed to start bridge: ${(err as Error).message}`);
      process.exit(1);
    }

    const shutdown = () => {
      log('shutting down bridge...');
      client.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  logErr(`unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
