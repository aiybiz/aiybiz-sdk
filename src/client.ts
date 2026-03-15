import { EventEmitter } from 'events';
import { AiybizConfig, ActivateResponse, WsMessage } from './types';
import { WsManager } from './ws';
import { Heartbeat } from './heartbeat';

const DEFAULTS = {
  capabilities: [] as string[],
  heartbeatInterval: 30000,
  reconnectBaseDelay: 1000,
  maxReconnectAttempts: Infinity,
};

async function activateWithRetry(
  marketplaceUrl: string,
  instanceToken: string,
  capabilities: string[],
): Promise<ActivateResponse> {
  const url = `${marketplaceUrl}/activate`;
  const body = JSON.stringify({ capabilities });
  const headers = {
    Authorization: `Bearer ${instanceToken}`,
    'Content-Type': 'application/json',
  };

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

export class AiybizClient extends EventEmitter {
  private config: Required<AiybizConfig>;
  private _instanceId: string | null = null;
  private wsManager: WsManager | null = null;
  private heartbeat: Heartbeat | null = null;

  constructor(config: AiybizConfig) {
    super();
    this.config = { ...DEFAULTS, ...config };
  }

  async connect(): Promise<void> {
    const { marketplaceUrl, instanceToken, capabilities } = this.config;

    const activation = await activateWithRetry(marketplaceUrl, instanceToken, capabilities);
    this._instanceId = activation.instanceId;

    this.wsManager = new WsManager({
      wsUrl: activation.wsUrl,
      instanceId: activation.instanceId,
      capabilities,
      reconnectBaseDelay: this.config.reconnectBaseDelay,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      emitter: this,
    });

    this.heartbeat = new Heartbeat(this.wsManager, this.config.heartbeatInterval);

    this.once('connect', () => {
      this.heartbeat!.start();
    });

    await this.wsManager.connect();
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

  disconnect(): void {
    this.heartbeat?.stop();
    this.wsManager?.destroy();
    this._instanceId = null;
  }

  get isConnected(): boolean {
    return this.wsManager?.isConnected ?? false;
  }

  get id(): string | null {
    return this._instanceId;
  }
}
