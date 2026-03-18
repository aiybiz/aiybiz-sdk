import { parseArgs } from 'util';
import { resolve } from 'path';
import { resolveConfig } from './config';
import { AiybizClient } from './client';
import type { WsMessage } from './types';

/* eslint-disable @typescript-eslint/no-require-imports */
declare const require: NodeRequire;

function printHelp() {
  console.log(`
aiybiz — AIYBiz SDK CLI

Usage:
  aiybiz start --handler <path> [options]
  aiybiz check [options]

Commands:
  start   Connect to the marketplace and forward messages to your handler
  check   Validate config (dry run, no connection)

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

Environment variables:
  AIYBIZ_URL              Marketplace base URL (e.g. https://api.aiybiz.com)
  AIYBIZ_SESSION_ID       Session ID provisioned by the marketplace
  AIYBIZ_TOKEN            Instance token provisioned by the marketplace
  AIYBIZ_CAPABILITIES     Comma-separated capabilities (e.g. chat,files)
  AIYBIZ_HEARTBEAT_INTERVAL  Heartbeat interval in ms (default: 30000)
  AIYBIZ_RECONNECT_DELAY     Initial reconnect delay in ms (default: 1000)
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
      console.error('Error: --handler <path> is required for the start command');
      console.error('Run aiybiz --help for usage.');
      process.exit(1);
    }

    const handlerPath = resolve(values.handler);
    let handlerFn: (msg: WsMessage, client: AiybizClient) => void | Promise<void>;
    try {
      const mod = require(handlerPath) as unknown;
      handlerFn = typeof mod === 'function' ? (mod as typeof handlerFn) : (mod as Record<string, unknown>)?.default as typeof handlerFn;
      if (typeof handlerFn !== 'function') throw new Error('No default function export found');
    } catch (e) {
      console.error(`Error: failed to load handler at ${handlerPath}: ${(e as Error).message}`);
      process.exit(1);
    }

    const config = resolveConfig({}, values.config);
    const client = new AiybizClient(config);

    client.on('connect', () => console.log('[aiybiz] Connected to marketplace'));
    client.on('disconnect', (code, reason) =>
      console.log(`[aiybiz] Disconnected (${code}${reason ? ': ' + reason : ''})`),
    );
    client.on('reconnecting', (attempt, delay) =>
      console.log(`[aiybiz] Reconnecting… attempt ${attempt} in ${delay}ms`),
    );
    client.on('error', (err) => console.error('[aiybiz] Error:', err.message));
    client.on('message', async (msg: WsMessage) => {
      try {
        await handlerFn(msg, client);
      } catch (err) {
        console.error('[aiybiz] Handler error:', (err as Error).message);
      }
    });

    const shutdown = () => {
      console.log('\n[aiybiz] Shutting down…');
      client.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await client.connect();
    console.log(`[aiybiz] Ready — handler: ${handlerPath}`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
