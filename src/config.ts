import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { AiybizConfig } from './types';

interface ConfigFile {
  marketplaceUrl?: string;
  sessionId?: string;
  instanceToken?: string;
  capabilities?: string[];
  heartbeatInterval?: number;
  reconnectBaseDelay?: number;
  maxReconnectAttempts?: number;
}

/**
 * Resolves config by merging (lowest to highest priority):
 *   1. aiybiz.config.json / .aiybiz.json (file in cwd)
 *   2. AIYBIZ_* environment variables
 *   3. Explicit `overrides` passed to this function
 *
 * Throws if any required field is missing after merge.
 */
export function resolveConfig(
  overrides: Partial<AiybizConfig> = {},
  configFilePath?: string,
): AiybizConfig {
  const fromFile = loadConfigFile(configFilePath);
  const fromEnv = loadEnvConfig();
  const resolved = { ...fromFile, ...fromEnv, ...overrides };

  const missing: string[] = [];
  if (!resolved.marketplaceUrl) missing.push('marketplaceUrl (or AIYBIZ_URL)');
  if (!resolved.sessionId) missing.push('sessionId (or AIYBIZ_SESSION_ID)');
  if (!resolved.instanceToken) missing.push('instanceToken (or AIYBIZ_TOKEN)');
  if (missing.length > 0) {
    throw new Error(`Missing required config: ${missing.join(', ')}`);
  }

  return resolved as AiybizConfig;
}

function loadEnvConfig(): Partial<AiybizConfig> {
  const c: Partial<AiybizConfig> = {};
  if (process.env.AIYBIZ_URL) c.marketplaceUrl = process.env.AIYBIZ_URL;
  if (process.env.AIYBIZ_SESSION_ID) c.sessionId = process.env.AIYBIZ_SESSION_ID;
  if (process.env.AIYBIZ_TOKEN) c.instanceToken = process.env.AIYBIZ_TOKEN;
  if (process.env.AIYBIZ_CAPABILITIES) {
    c.capabilities = process.env.AIYBIZ_CAPABILITIES.split(',').map((s) => s.trim());
  }
  if (process.env.AIYBIZ_HEARTBEAT_INTERVAL) {
    c.heartbeatInterval = parseInt(process.env.AIYBIZ_HEARTBEAT_INTERVAL, 10);
  }
  if (process.env.AIYBIZ_RECONNECT_DELAY) {
    c.reconnectBaseDelay = parseInt(process.env.AIYBIZ_RECONNECT_DELAY, 10);
  }
  return c;
}

function loadConfigFile(filePath?: string): Partial<AiybizConfig> {
  const candidates = [filePath, 'aiybiz.config.json', '.aiybiz.json'].filter(Boolean) as string[];
  for (const p of candidates) {
    const abs = resolve(p);
    if (existsSync(abs)) {
      try {
        return JSON.parse(readFileSync(abs, 'utf-8')) as ConfigFile;
      } catch (e) {
        throw new Error(`Failed to parse config file ${abs}: ${(e as Error).message}`);
      }
    }
  }
  return {};
}
