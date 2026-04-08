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
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

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
  /**
   * Timeout in ms to wait for the gateway to start after container restart.
   * VPS cold-starts can take 60-120s depending on hardware.
   * Default: 180000 (180s)
   */
  startupTimeoutMs?: number;
}

const log = (msg: string) => console.log(`[aiybiz:setup:openclaw] ${new Date().toISOString()} ${msg}`);
const logErr = (msg: string) => console.error(`[aiybiz:setup:openclaw] ${new Date().toISOString()} ERROR ${msg}`);

type ProviderConfig = OpenClawSetupOptions['providerConfig'];

/**
 * Build the openclaw.json config object (shared between local and container setup).
 */
export function buildOpenClawConfig(
  token: string,
  providerEnv: Record<string, string>,
  p: ProviderConfig,
): object {
  return {
    commands: { native: 'auto', nativeSkills: 'auto', restart: true, ownerDisplay: 'raw' },
    skills: {
      browser: { engine: 'lightpanda' },
    },
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
}

/**
 * Write openclaw.json directly to a local path (used in embedded/in-container mode).
 * Call this before starting the OpenClaw process so it picks up the config on first boot.
 */
export function writeOpenClawConfigLocal(opts: {
  token: string;
  providerEnv: Record<string, string>;
  providerConfig: ProviderConfig;
  configPath: string;
}): void {
  const config = buildOpenClawConfig(opts.token, opts.providerEnv, opts.providerConfig);
  const json = JSON.stringify(config, null, 2);
  mkdirSync(dirname(opts.configPath), { recursive: true });
  writeFileSync(opts.configPath, json, { encoding: 'utf-8', mode: 0o600 });
  log(`openclaw.json written to ${opts.configPath}`);
}

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
    startupTimeoutMs = 180000,
  } = opts;

  log(`setting up container: ${container}`);

  const config = buildOpenClawConfig(token, providerEnv, p);
  const json = JSON.stringify(config, null, 2);

  // Wait for OpenClaw to create its config directory (it does so on first startup)
  log(`waiting for OpenClaw config dir to appear in container ${container}`);
  await waitForConfigDir(container, 60000);

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
 * Wait until OpenClaw creates its config file inside the container.
 * This happens during the first few seconds of container startup.
 */
async function waitForConfigDir(container: string, timeoutMs = 60000): Promise<void> {
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
 * Wait until the OpenClaw gateway is reachable.
 *
 * Strategy:
 *  1. First wait for the port to be open (TCP-level check via a lightweight HEAD request)
 *  2. Then confirm the chat completions endpoint responds 2xx
 *
 * VPS note: container restart + gateway init can take 40-60s on shared hardware.
 * The default timeout is 90s to accommodate slow cold-starts.
 */
export async function waitForGateway(
  gatewayUrl: string,
  token: string,
  timeoutMs = 180000,
): Promise<void> {
  const start = Date.now();
  const interval = 3000;

  log(`waiting for gateway at ${gatewayUrl} (timeout: ${timeoutMs}ms)`);

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;

    try {
      // Step 1: lightweight connectivity check — just hit the root path
      const probe = await fetch(gatewayUrl, {
        signal: AbortSignal.timeout(4000),
      }).catch(() => null);

      if (probe !== null) {
        // Port is open — now confirm the chat completions endpoint is up
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
          signal: AbortSignal.timeout(8000),
        });

        if (res.ok) {
          log(`gateway ready after ${Date.now() - start}ms`);
          return;
        }

        const body = await res.text().catch(() => '');
        log(`gateway reachable but not ready yet (HTTP ${res.status}: ${body.slice(0, 120)}), retrying in ${interval}ms... [${elapsed}ms elapsed]`);
      } else {
        log(`gateway port not open yet, retrying in ${interval}ms... [${elapsed}ms elapsed]`);
      }
    } catch (err) {
      log(`gateway not reachable yet (${(err as Error).message}), retrying in ${interval}ms... [${elapsed}ms elapsed]`);
    }

    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(
    `OpenClaw gateway at ${gatewayUrl} did not become ready within ${timeoutMs}ms. ` +
    'Check container logs: docker logs <container-name> --tail 20',
  );
}

/**
 * Launch a new OpenClaw Docker container.
 * Returns the container name.
 */
export function launchOpenClawContainer(opts: {
  image?: string;
  name: string;
  hostPort?: number;
  restart?: string;
}): string {
  const image = opts.image ?? 'ghcr.io/openclaw/openclaw:main-slim';
  const hostPort = opts.hostPort ?? 18789;

  log(`launching container ${opts.name} from ${image} on port ${hostPort}`);

  const args = ['run', '-d', '--name', opts.name, '-p', `${hostPort}:18789`];
  if (opts.restart) args.push('--restart', opts.restart);
  args.push(image);

  const result = spawnSync('docker', args, { encoding: 'utf-8' });

  if (result.status !== 0) {
    logErr(`docker run failed: ${result.stderr}`);
    throw new Error(`Failed to launch container ${opts.name}: ${result.stderr}`);
  }

  const containerId = result.stdout.trim().slice(0, 12);
  log(`container launched: ${opts.name} (${containerId})`);
  return opts.name;
}
