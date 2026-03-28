import { parseArgs } from 'util';
import { resolve, join } from 'path';
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { resolveConfig } from './config';
import { AiybizClient } from './client';
import { startOpenClawBridge, startOpenClawBridgeFromEnv } from './bridge/openclaw-bridge';
import { startPushServer } from './bridge/push-server';
import { launchOpenClawContainer, setupOpenClawContainer, writeOpenClawConfigLocal, waitForGateway } from './setup/openclaw';
import type { WsMessage } from './types';

/* eslint-disable @typescript-eslint/no-require-imports */
declare const require: NodeRequire;

const log = (msg: string) => console.log(`[aiybiz:cli] ${new Date().toISOString()} ${msg}`);
const logErr = (msg: string) => console.error(`[aiybiz:cli] ${new Date().toISOString()} ERROR ${msg}`);

// ── Registry ─────────────────────────────────────────────────────────────────

interface AgentRecord {
  sessionId: string;
  container: string;
  hostPort: number;
  gatewayUrl: string;
  token: string;
  provider: {
    name: string;
    url: string;
    model: string;
    modelId: string;
    modelName: string;
  };
  createdAt: string;
}

interface AgentRegistry {
  version: number;
  agents: AgentRecord[];
}

function readRegistry(path: string): AgentRegistry {
  if (!existsSync(path)) return { version: 1, agents: [] };
  return JSON.parse(readFileSync(path, 'utf-8')) as AgentRegistry;
}

function writeRegistry(path: string, registry: AgentRegistry): void {
  writeFileSync(path, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

function nextAvailablePort(registry: AgentRegistry, base = 18789): number {
  const used = new Set(registry.agents.map(a => a.hostPort));
  let port = base;
  while (used.has(port)) port++;
  return port;
}

// ── Help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
aiybiz — AIYBiz SDK CLI

Usage:
  aiybiz deploy-openclaw       Build + run a self-contained agent container
  aiybiz start-embedded        Start bridge inside a container (called by entrypoint)
  aiybiz write-openclaw-config Write openclaw.json from env vars (called by entrypoint)
  aiybiz list                  Show all registered agents and container status
  aiybiz start-all             Restart all agent containers (they manage their own bridge)
  aiybiz start-openclaw        Start a single bridge from env vars (legacy host mode)
  aiybiz start                 Connect with a custom message handler
  aiybiz check                 Validate config (dry run)

────────────────────────────────────────────────────────
deploy-openclaw — Build + provision a self-contained agent
────────────────────────────────────────────────────────
Builds an embedded Docker image (OpenClaw + aiybiz bridge + Lightpanda)
and runs it as a fully autonomous container. The bridge runs INSIDE the
container — no host process needed. Use --restart=always for auto-recovery.

Required env vars:
  AIYBIZ_URL              Marketplace URL (e.g. https://api.aiybiz.com)
  AIYBIZ_SESSION_ID       Session ID provisioned by the marketplace
  OPENCLAW_PROVIDER_NAME  LLM provider name (e.g. moonshot)
  OPENCLAW_PROVIDER_URL   LLM provider base URL
  OPENCLAW_PROVIDER_KEY   LLM provider API key
  OPENCLAW_MODEL          Full model name (e.g. moonshot/kimi-k2.5)
  OPENCLAW_MODEL_ID       Model ID (e.g. kimi-k2.5)

Optional env vars:
  OPENCLAW_MODEL_NAME          Display name (default: OPENCLAW_MODEL_ID)
  OPENCLAW_PROVIDER_API        API type (default: openai-completions)
  OPENCLAW_TOKEN               Gateway auth token (auto-generated if not set)
  OPENCLAW_RESTART             Docker restart policy (default: always)
  OPENCLAW_STARTUP_TIMEOUT_MS  Bridge startup timeout ms (default: 120000)
  AIYBIZ_PUSH_PORT             Internal push server port (default: 3099)
  AIYBIZ_REGISTRY              Registry file path (default: ./aiybiz-registry.json)

────────────────────────────────────────────────────────
start-embedded — Run bridge inside the container (entrypoint uses this)
────────────────────────────────────────────────────────
Required env vars (set by deploy-openclaw when running the container):
  AIYBIZ_URL, AIYBIZ_SESSION_ID, OPENCLAW_TOKEN

Optional:
  OPENCLAW_URL             Gateway URL (default: http://localhost:18789)
  AIYBIZ_PUSH_PORT         Internal push server port (default: 3099)
  OPENCLAW_HEALTH_INTERVAL_MS  Health check interval ms (default: 120000)

The push server allows async pushes from within the container:
  curl -X POST http://localhost:3099/push \\
    -H "Content-Type: application/json" \\
    -d '{"content": "Task done!", "meta": {"job": "scrape"}}'
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

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

  // ── list ──────────────────────────────────────────────────────────────────
  if (command === 'list') {
    const registryPath = process.env.AIYBIZ_REGISTRY ?? './aiybiz-registry.json';
    const registry = readRegistry(registryPath);

    if (registry.agents.length === 0) {
      console.log('No agents registered. Run deploy-openclaw to provision one.');
      process.exit(0);
    }

    console.log(`\nAGENTS (${registry.agents.length}) — registry: ${registryPath}\n`);
    console.log(
      'SESSION'.padEnd(38) + 'CONTAINER'.padEnd(26) + 'PORT'.padEnd(8) + 'MODEL'.padEnd(24) + 'CREATED',
    );
    console.log('─'.repeat(110));
    for (const a of registry.agents) {
      console.log(
        a.sessionId.padEnd(38) +
        a.container.padEnd(26) +
        String(a.hostPort).padEnd(8) +
        a.provider.model.padEnd(24) +
        a.createdAt.slice(0, 10),
      );
    }
    console.log('');
    process.exit(0);
  }

  // ── start ─────────────────────────────────────────────────────────────────
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

  // ── write-openclaw-config ─────────────────────────────────────────────────
  // Called by docker-entrypoint.sh before OpenClaw starts.
  if (command === 'write-openclaw-config') {
    const token = process.env.OPENCLAW_TOKEN;
    if (!token) { logErr('OPENCLAW_TOKEN is required'); process.exit(1); }

    const providerName = process.env.OPENCLAW_PROVIDER_NAME;
    const providerUrl  = process.env.OPENCLAW_PROVIDER_URL;
    const providerKey  = process.env.OPENCLAW_PROVIDER_KEY;
    const providerApi  = process.env.OPENCLAW_PROVIDER_API ?? 'openai-completions';
    const modelFull    = process.env.OPENCLAW_MODEL;
    const modelId      = process.env.OPENCLAW_MODEL_ID;
    const modelName    = process.env.OPENCLAW_MODEL_NAME ?? modelId ?? 'Default Model';

    if (!providerName || !providerUrl || !providerKey || !modelFull || !modelId) {
      logErr('Missing provider env vars: OPENCLAW_PROVIDER_NAME, OPENCLAW_PROVIDER_URL, OPENCLAW_PROVIDER_KEY, OPENCLAW_MODEL, OPENCLAW_MODEL_ID');
      process.exit(1);
    }

    const apiKeyEnvVar = `${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const configPath = process.env.OPENCLAW_CONFIG_PATH
      ?? join(process.env.HOME ?? '/root', '.openclaw', 'openclaw.json');

    writeOpenClawConfigLocal({
      token,
      providerEnv: { [apiKeyEnvVar]: providerKey },
      providerConfig: { name: providerName, baseUrl: providerUrl, apiKeyEnvVar, api: providerApi, defaultModel: modelFull, modelId, modelName },
      configPath,
    });

    log(`openclaw.json written → ${configPath}`);
    process.exit(0);
  }

  // ── start-embedded ────────────────────────────────────────────────────────
  // Long-running bridge process that runs INSIDE the container.
  // Called by docker-entrypoint.sh after OpenClaw has been started.
  if (command === 'start-embedded') {
    const marketplaceUrl = process.env.AIYBIZ_URL;
    const sessionId      = process.env.AIYBIZ_SESSION_ID;
    const token          = process.env.OPENCLAW_TOKEN;

    if (!marketplaceUrl || !sessionId || !token) {
      logErr('start-embedded requires: AIYBIZ_URL, AIYBIZ_SESSION_ID, OPENCLAW_TOKEN');
      process.exit(1);
    }

    const openclawUrl        = process.env.OPENCLAW_URL ?? 'http://localhost:18789';
    const pushPort           = parseInt(process.env.AIYBIZ_PUSH_PORT ?? '3099', 10);
    const startupTimeoutMs   = parseInt(process.env.OPENCLAW_STARTUP_TIMEOUT_MS ?? '120000', 10);
    const healthIntervalMs   = parseInt(process.env.OPENCLAW_HEALTH_INTERVAL_MS ?? '120000', 10);

    log(`command=start-embedded session=${sessionId.slice(0, 8)}`);
    log(`waiting for OpenClaw at ${openclawUrl}...`);

    // In embedded mode, wait for port reachability only (config is pre-written before start)
    try {
      const start = Date.now();
      while (Date.now() - start < startupTimeoutMs) {
        try {
          await fetch(openclawUrl, { signal: AbortSignal.timeout(3000) });
          log(`OpenClaw is up (${Date.now() - start}ms)`);
          break;
        } catch {
          await new Promise(r => setTimeout(r, 2000));
        }
        if (Date.now() - start >= startupTimeoutMs) {
          throw new Error(`OpenClaw not reachable after ${startupTimeoutMs}ms`);
        }
      }
    } catch (err) {
      logErr(`OpenClaw did not start in time: ${(err as Error).message}`);
      process.exit(1);
    }

    let client: AiybizClient;
    try {
      client = await startOpenClawBridge({
        marketplaceUrl,
        sessionId,
        openclawUrl,
        openclawToken: token,
        healthCheckIntervalMs: healthIntervalMs,
      });
    } catch (err) {
      logErr(`bridge failed: ${(err as Error).message}`);
      process.exit(1);
    }

    startPushServer(client, pushPort);

    const shutdown = () => {
      log('shutting down bridge...');
      client.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  // ── start-openclaw ────────────────────────────────────────────────────────
  if (command === 'start-openclaw') {
    log('command=start-openclaw');
    log(`AIYBIZ_URL=${process.env.AIYBIZ_URL ?? '(not set)'}`);
    log(`AIYBIZ_SESSION_ID=${process.env.AIYBIZ_SESSION_ID ?? '(not set)'}`);
    log(`OPENCLAW_URL=${process.env.OPENCLAW_URL ?? '(not set)'}`);
    log(`OPENCLAW_AGENT_ID=${process.env.OPENCLAW_AGENT_ID ?? 'main'}`);

    // If OPENCLAW_URL/TOKEN not set, try loading from registry
    if (!process.env.OPENCLAW_URL || !process.env.OPENCLAW_TOKEN) {
      const registryPath = process.env.AIYBIZ_REGISTRY ?? './aiybiz-registry.json';
      const sessionId = process.env.AIYBIZ_SESSION_ID;
      if (sessionId && existsSync(registryPath)) {
        const registry = readRegistry(registryPath);
        const agent = registry.agents.find(a => a.sessionId === sessionId);
        if (agent) {
          log(`loaded openclaw config from registry for session ${sessionId.slice(0, 8)}`);
          process.env.OPENCLAW_URL = agent.gatewayUrl;
          process.env.OPENCLAW_TOKEN = agent.token;
        }
      }
    }

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

  // ── start-all ─────────────────────────────────────────────────────────────
  // In embedded mode, each container manages its own bridge.
  // start-all just ensures all containers are running.
  if (command === 'start-all') {
    log('command=start-all');

    const registryPath = process.env.AIYBIZ_REGISTRY ?? './aiybiz-registry.json';
    const registry = readRegistry(registryPath);

    if (registry.agents.length === 0) {
      logErr(`no agents in registry (${registryPath}). Run deploy-openclaw first.`);
      process.exit(1);
    }

    log(`ensuring ${registry.agents.length} agent container(s) are running`);

    let started = 0;
    for (const agent of registry.agents) {
      const result = spawnSync('docker', ['start', agent.container], { encoding: 'utf-8' });
      if (result.status === 0) {
        log(`  ✅ ${agent.container} started`);
        started++;
      } else {
        logErr(`  ❌ ${agent.container} failed to start: ${result.stderr.trim()}`);
      }
    }

    log(`${started}/${registry.agents.length} container(s) running`);
    log('Each container runs its own bridge — no host process needed.');
    process.exit(started === 0 ? 1 : 0);
  }

  // ── deploy-openclaw ───────────────────────────────────────────────────────
  if (command === 'deploy-openclaw') {
    log('command=deploy-openclaw');

    const marketplaceUrl = process.env.AIYBIZ_URL;
    const sessionId      = process.env.AIYBIZ_SESSION_ID;

    if (!marketplaceUrl) { logErr('AIYBIZ_URL is required'); process.exit(1); }
    if (!sessionId)      { logErr('AIYBIZ_SESSION_ID is required'); process.exit(1); }

    const providerName = process.env.OPENCLAW_PROVIDER_NAME;
    const providerUrl  = process.env.OPENCLAW_PROVIDER_URL;
    const providerKey  = process.env.OPENCLAW_PROVIDER_KEY;
    const modelFull    = process.env.OPENCLAW_MODEL;
    const modelId      = process.env.OPENCLAW_MODEL_ID;

    if (!providerName || !providerUrl || !providerKey || !modelFull || !modelId) {
      logErr('Required: OPENCLAW_PROVIDER_NAME, OPENCLAW_PROVIDER_URL, OPENCLAW_PROVIDER_KEY, OPENCLAW_MODEL, OPENCLAW_MODEL_ID');
      process.exit(1);
    }

    const registryPath  = process.env.AIYBIZ_REGISTRY ?? './aiybiz-registry.json';
    const registry      = readRegistry(registryPath);

    if (registry.agents.find(a => a.sessionId === sessionId)) {
      logErr(`session ${sessionId} already in registry. Use "aiybiz list" or remove the entry to redeploy.`);
      process.exit(1);
    }

    const shortId       = sessionId.slice(0, 8);
    const containerName = `openclaw-${shortId}`;
    const hostPort      = nextAvailablePort(registry);
    const restartPolicy = process.env.OPENCLAW_RESTART ?? 'always';
    const modelName     = process.env.OPENCLAW_MODEL_NAME ?? modelId;
    const pushPort      = parseInt(process.env.AIYBIZ_PUSH_PORT ?? '3099', 10);

    const { randomBytes } = require('crypto') as typeof import('crypto');
    const token = process.env.OPENCLAW_TOKEN ?? randomBytes(24).toString('hex');

    // ── Step 1: Build embedded image ────────────────────────────────────────
    const embeddedImage = process.env.OPENCLAW_IMAGE ?? 'aiybiz-openclaw:latest';
    const needsBuild = !process.env.OPENCLAW_IMAGE; // only build if using default

    if (needsBuild) {
      log('step 1/3: building embedded image (OpenClaw + aiybiz bridge + Lightpanda)');

      // Find SDK root (this file lives at dist/cli.js → up one level = sdk root)
      const sdkRoot = resolve(__dirname, '..');
      const buildCtx = join(require('os').tmpdir(), `aiybiz-build-${shortId}`);
      mkdirSync(buildCtx, { recursive: true });

      // Pack the SDK into a tarball for the Docker build
      log(`  packing SDK from ${sdkRoot}`);
      spawnSync('npm', ['pack', sdkRoot, '--pack-destination', buildCtx], { encoding: 'utf-8', stdio: 'inherit' });
      const tgzFiles = require('fs').readdirSync(buildCtx).filter((f: string) => f.endsWith('.tgz'));
      if (tgzFiles.length === 0) { logErr('npm pack failed — no .tgz found'); process.exit(1); }
      const tgzName = tgzFiles[0] as string;

      // Copy Dockerfile and entrypoint
      copyFileSync(join(sdkRoot, 'Dockerfile.openclaw-embedded'), join(buildCtx, 'Dockerfile'));
      copyFileSync(join(sdkRoot, 'docker-entrypoint.sh'), join(buildCtx, 'docker-entrypoint.sh'));

      log(`  running docker build -t ${embeddedImage} (this may take a few minutes on first run)`);
      const buildResult = spawnSync(
        'docker', ['build', '--build-arg', `AIYBIZ_TGZ=${tgzName}`, '-t', embeddedImage, buildCtx],
        { encoding: 'utf-8', stdio: 'inherit' },
      );
      if (buildResult.status !== 0) {
        logErr('docker build failed');
        process.exit(1);
      }
      log(`  image built: ${embeddedImage}`);
    } else {
      log(`step 1/3: using existing image ${embeddedImage}`);
    }

    // ── Step 2: Run container ────────────────────────────────────────────────
    log(`step 2/3: launching container ${containerName} on port ${hostPort}`);

    const apiKeyEnvVar = `${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
    const envArgs = [
      '-e', `AIYBIZ_URL=${marketplaceUrl}`,
      '-e', `AIYBIZ_SESSION_ID=${sessionId}`,
      '-e', `OPENCLAW_TOKEN=${token}`,
      '-e', `OPENCLAW_PROVIDER_NAME=${providerName}`,
      '-e', `OPENCLAW_PROVIDER_URL=${providerUrl}`,
      '-e', `OPENCLAW_PROVIDER_KEY=${providerKey}`,
      '-e', `${apiKeyEnvVar}=${providerKey}`,
      '-e', `OPENCLAW_MODEL=${modelFull}`,
      '-e', `OPENCLAW_MODEL_ID=${modelId}`,
      '-e', `OPENCLAW_MODEL_NAME=${modelName}`,
      '-e', `OPENCLAW_PROVIDER_API=${process.env.OPENCLAW_PROVIDER_API ?? 'openai-completions'}`,
      '-e', `AIYBIZ_PUSH_PORT=${pushPort}`,
    ];
    if (process.env.OPENCLAW_HEALTH_INTERVAL_MS) {
      envArgs.push('-e', `OPENCLAW_HEALTH_INTERVAL_MS=${process.env.OPENCLAW_HEALTH_INTERVAL_MS}`);
    }

    const runArgs = [
      'run', '-d',
      '--name', containerName,
      '-p', `${hostPort}:18789`,
      '--restart', restartPolicy,
      ...envArgs,
      embeddedImage,
    ];

    const runResult = spawnSync('docker', runArgs, { encoding: 'utf-8' });
    if (runResult.status !== 0) {
      logErr(`docker run failed: ${runResult.stderr}`);
      process.exit(1);
    }
    log(`container started: ${containerName} (${runResult.stdout.trim().slice(0, 12)})`);

    // ── Step 3: Save to registry ─────────────────────────────────────────────
    log('step 3/3: saving to registry');
    registry.agents.push({
      sessionId,
      container: containerName,
      hostPort,
      gatewayUrl: `http://localhost:${hostPort}`,
      token,
      provider: { name: providerName, url: providerUrl, model: modelFull, modelId, modelName },
      createdAt: new Date().toISOString(),
    });
    writeRegistry(registryPath, registry);

    log('');
    log(`✅ Agent deployed successfully`);
    log(`   session   : ${sessionId}`);
    log(`   container : ${containerName}`);
    log(`   port      : ${hostPort}`);
    log(`   push API  : http://localhost:${pushPort}/push  (inside container)`);
    log(`   restart   : ${restartPolicy}`);
    log('');
    log('The bridge runs INSIDE the container. No host process needed.');
    log(`Monitor: docker logs -f ${containerName}`);
    process.exit(0);
  }

  logErr(`unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
