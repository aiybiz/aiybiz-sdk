import { EventEmitter } from 'events';
import { AiybizConfig, ActivateResponse, AgentCronJobBody, AgentCronJobRow, WsMessage } from './types';
import { WsManager } from './ws';
import { Heartbeat } from './heartbeat';
import { resolveConfig } from './config';

const DEFAULTS = {
  capabilities: [] as string[],
  heartbeatInterval: 30000,
  reconnectBaseDelay: 1000,
  maxReconnectAttempts: Infinity,
};

async function activateWithRetry(
  marketplaceUrl: string,
  sessionId: string,
  instanceToken: string,
  capabilities: string[],
): Promise<ActivateResponse> {
  const url = `${marketplaceUrl}/agent/sessions/${sessionId}/activate`;
  const body = JSON.stringify({ capabilities });
  const headers = agentRequestHeaders(instanceToken);

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
    const res = await fetch(url, { method: 'POST', headers, body });

    if (res.status === 401) throw new Error('Invalid instance token');
    if (res.status === 404) throw new Error('Instance not found');
    if (res.ok) return res.json() as Promise<ActivateResponse>;

    lastError = new Error(`Activate failed with status ${res.status}`);
  }
  throw lastError ?? new Error('Activate failed');
}

function agentRequestHeaders(instanceToken: string): Record<string, string> {
  return {
    // TODO: re-add Authorization once token flow is stable
    // Authorization: `Bearer ${instanceToken}`,
    'Content-Type': 'application/json',
  };
}

export class AiybizClient extends EventEmitter {
  private config: Required<AiybizConfig>;
  private _instanceId: string | null = null;
  private wsManager: WsManager | null = null;
  private heartbeat: Heartbeat | null = null;

  /**
   * @param config Partial config — any missing required field is read from
   *   AIYBIZ_URL / AIYBIZ_SESSION_ID / AIYBIZ_TOKEN env vars or aiybiz.config.json.
   */
  constructor(config?: Partial<AiybizConfig>) {
    super();
    this.config = { ...DEFAULTS, ...resolveConfig(config) };
  }

  async connect(): Promise<void> {
    const { marketplaceUrl, instanceToken, capabilities, heartbeatInterval, reconnectBaseDelay, maxReconnectAttempts } = this.config;
    const sessionId = this.config.sessionId;

    await activateWithRetry(marketplaceUrl, sessionId, instanceToken, capabilities);
    this._instanceId = sessionId;

    // Derive WS URL from marketplaceUrl (http→ws, https→wss)
    const wsUrl = marketplaceUrl.replace(/^http/, 'ws') + `/agent/ws?sessionId=${sessionId}`;

    this.wsManager = new WsManager({
      wsUrl,
      instanceId: sessionId,
      capabilities,
      reconnectBaseDelay,
      maxReconnectAttempts,
      emitter: this,
    });

    await this.wsManager.connect();
    // Note: WsManager already emits 'connect' on this (shared emitter) when WS opens.
    // No need to re-emit here.

    this.heartbeat = new Heartbeat(this.wsManager, heartbeatInterval);
    this.heartbeat.start();
  }

  send(msg: Omit<WsMessage, 'instanceId' | 'timestamp'>): void {
    if (!this.wsManager?.isConnected) {
      throw new Error('Not connected. Call connect() first.');
    }
    this.wsManager.send({ ...msg, instanceId: this._instanceId ?? undefined, timestamp: Date.now() });
  }

  pulse(content: string, meta?: Record<string, unknown>): void {
    this.send({ type: 'pulse', content, meta });
  }

  /**
   * Full replace of cron jobs for this session on the marketplace (agent auth, no user JWT).
   * Same shape as `PUT /agent/sessions/:sessionId/cron-jobs` — at most 100 jobs; duplicate `id` in one payload is rejected by the API.
   */
  async replaceAgentCronJobs(jobs: AgentCronJobBody[]): Promise<{ jobs: AgentCronJobRow[] }> {
    const { marketplaceUrl, sessionId, instanceToken } = this.config;
    if (jobs.length > 100) {
      throw new Error('replaceAgentCronJobs: at most 100 jobs per request');
    }
    const url = `${marketplaceUrl}/agent/sessions/${sessionId}/cron-jobs`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: agentRequestHeaders(instanceToken),
      body: JSON.stringify({ jobs }),
    });
    if (res.status === 401) throw new Error('Invalid instance token');
    if (res.status === 404) throw new Error('Session not found');
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const errBody = (await res.json()) as { error?: string; message?: string };
        detail = errBody.error ?? errBody.message ?? detail;
      } catch { /* ignore */ }
      throw new Error(`replaceAgentCronJobs failed (${res.status}): ${detail}`);
    }
    return res.json() as Promise<{ jobs: AgentCronJobRow[] }>;
  }

  disconnect(): void {
    this.heartbeat?.stop();
    this.wsManager?.destroy();
    this._instanceId = null;
    this.emit('disconnect', 0, 'disconnected');
  }

  get isConnected(): boolean {
    return this.wsManager?.isConnected ?? false;
  }

  get id(): string | null {
    return this._instanceId;
  }

  get instanceId(): string | null {
    return this._instanceId;
  }
}
