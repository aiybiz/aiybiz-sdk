/**
 * OpenClaw container setup helpers.
 *
 * Handles:
 *  - Writing the openclaw.json config inside a running container
 *  - Restarting the container
 *  - Waiting for the gateway to be healthy
 *  - Verifying the chat completions endpoint
 */

import { execSync, spawnSync } from 'child_process';

export interface OpenClawSetupOptions {
  /** Docker container name or ID */
  container: string;
  /** OpenClaw gateway auth token (generated or provided) */
  token: string;
  /** LLM provider env vars, e.g. { MOONSHOT_API_KEY: 'sk-...' } */
  providerEnv: Record<string, string>;
  /** Provider configuration block for openclaw.json */
  providerConfig: {
    name: string; // e.g. "moonshot"
    baseUrl: string; // e.g. "https://api.moonshot.ai/v1"
    apiKeyEnvVar: string; // e.g. "MOONSHOT_API_KEY"
    api: string; // e.g. "openai-completions"
    defaultModel: string; // e.g. "moonshot/kimi-k2.5"
    modelId: string; // e.g. "kimi-k2.5"
    modelName: string; // e.g. "Kimi K2.5"
    modelReasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
  };
  /** Timeout in ms to wait for the gateway to start (default: 30000) */
  startupTimeoutMs?: number;
}

const log = (msg: string) => console.log(`[aiybiz:setup:openclaw] ${new Date().toISOString()} ${msg}`);
const logErr = (msg: string) => console.error(`[aiybiz:setup:openclaw] ${new Date().toISOString()} ERROR ${msg}`);

/**
 * Write openclaw.json inside the container and restart it.
 * Returns the gateway URL (using host port mapping).
 */
export async function setupOpenClawContainer(opts: OpenClawSetupOptions): Promise<string> {
  const {
    container,
    token,
    providerEnv,
    providerConfig: p,
    startupTimeoutMs = 30000,
  } = opts;

  log(`setting up container: ${container}`);

  // Build the config
  const config = {
    commands: { native: 'auto', nativeSkills: 'auto', restart: true, ownerDisplay: 'raw' },
    gateway: {
      auth: { mode: 'token', token },
      bind: 'lan',
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    env: providerEnv,
    agents: {
      defaults: {
        model: { primary: p.defaultModel },
        models: { [p.defaultModel]: { alias: p.modelName } },
      },
    },
    models: {
      mode: 'merge',
      providers: {
        [p.name]: {
          baseUrl: p.baseUrl,
          apiKey: `\${${p.apiKeyEnvVar}}`,
          api: p.api,
          models: [
            {
              id: p.modelId,
              name: p.modelName,
              reasoning: p.modelReasoning ?? false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: p.contextWindow ?? 131072,
              maxTokens: p.maxTokens ?? 8192,
            },
          ],
        },
      },
    },
    meta: {
      lastTouchedVersion: '2026.3.9',
      lastTouchedAt: new Date().toISOString(),
    },
  };

  const json = JSON.stringify(config, null, 2);

  // Wait for OpenClaw to create its config directory (it does so on first startup)
  log(`waiting for OpenClaw config dir to appear in container ${container}`);
  await waitForConfigDir(container, 30000);

  log(`writing openclaw.json to container ${container}`);
  const writeResult = spawnSync('docker', [
    'exec', container,
    'sh', '-c', `cat > /home/node/.openclaw/openclaw.json << 'EOFJSON'\n${json}\nEOFJSON`,
  ], { encoding: 'utf-8' });

  if (writeResult.status !== 0) {
    logErr(`failed to write config: ${writeResult.stderr}`);
    throw new Error(`Failed to write openclaw.json to container ${container}: ${writeResult.stderr}`);
  }
  log('openclaw.json written successfully');

  // Restart container to apply config
  log(`restarting container ${container}`);
  const restartResult = spawnSync('docker', ['restart', container], { encoding: 'utf-8' });
  if (restartResult.status !== 0) {
    logErr(`failed to restart container: ${restartResult.stderr}`);
    throw new Error(`Failed to restart container ${container}: ${restartResult.stderr}`);
  }
  log('container restarted');

  // Get the host port mapping
  const port = getGatewayHostPort(container);
  const gatewayUrl = `http://localhost:${port}`;
  log(`gateway URL: ${gatewayUrl}`);

  // Wait for gateway to be healthy
  await waitForGateway(gatewayUrl, token, startupTimeoutMs);

  return gatewayUrl;
}

/**
 * Get the host port mapped to 18789 for a container.
 */
export function getGatewayHostPort(container: string): number {
  try {
    const result = execSync(
      `docker inspect ${container} --format '{{(index (index .NetworkSettings.Ports "18789/tcp") 0).HostPort}}'`,
      { encoding: 'utf-8' },
    ).trim();
    const port = parseInt(result, 10);
    if (isNaN(port)) throw new Error(`invalid port: ${result}`);
    return port;
  } catch (err) {
    logErr(`could not detect host port for container ${container}: ${(err as Error).message}`);
    return 18789; // default fallback
  }
}

/**
 * Wait until OpenClaw creates its config directory inside the container.
 * This happens during the first few seconds of container startup.
 */
async function waitForConfigDir(container: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  const interval = 1000;

  while (Date.now() - start < timeoutMs) {
    const result = spawnSync('docker', [
      'exec', container,
      'test', '-f', '/home/node/.openclaw/openclaw.json',
    ], { encoding: 'utf-8' });

    if (result.status === 0) {
      log(`config dir ready (${Date.now() - start}ms)`);
      return;
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`OpenClaw config dir did not appear in container ${container} within ${timeoutMs}ms`);
}

/**
 * Wait until the OpenClaw gateway responds to a ping via chat completions.
 */
export async function waitForGateway(
  gatewayUrl: string,
  token: string,
  timeoutMs = 30000,
): Promise<void> {
  const start = Date.now();
  const interval = 2000;

  log(`waiting for gateway at ${gatewayUrl} (timeout: ${timeoutMs}ms)`);

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'openclaw:main',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 10,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) {
        const elapsed = Date.now() - start;
        log(`gateway ready after ${elapsed}ms`);
        return;
      }

      const status = res.status;
      log(`gateway not ready yet (HTTP ${status}), retrying in ${interval}ms...`);
    } catch {
      log(`gateway not reachable yet, retrying in ${interval}ms...`);
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`OpenClaw gateway at ${gatewayUrl} did not become ready within ${timeoutMs}ms`);
}

/**
 * Launch a new OpenClaw Docker container.
 * Returns the container name.
 */
export function launchOpenClawContainer(opts: {
  image?: string;
  name: string;
  hostPort?: number;
}): string {
  const image = opts.image ?? 'ghcr.io/openclaw/openclaw:main-slim';
  const hostPort = opts.hostPort ?? 18789;

  log(`launching container ${opts.name} from ${image} on port ${hostPort}`);

  const result = spawnSync('docker', [
    'run', '-d',
    '--name', opts.name,
    '-p', `${hostPort}:18789`,
    image,
  ], { encoding: 'utf-8' });

  if (result.status !== 0) {
    logErr(`docker run failed: ${result.stderr}`);
    throw new Error(`Failed to launch container ${opts.name}: ${result.stderr}`);
  }

  const containerId = result.stdout.trim().slice(0, 12);
  log(`container launched: ${opts.name} (${containerId})`);
  return opts.name;
}
