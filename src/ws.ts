import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { WsMessage } from './types';

export interface WsManagerOptions {
  wsUrl: string;
  instanceId: string;
  capabilities: string[];
  reconnectBaseDelay: number;
  maxReconnectAttempts: number;
  emitter: EventEmitter;
}

export class WsManager {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _isConnected = false;
  private destroyed = false;

  constructor(private opts: WsManagerOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onFirstConnect = () => {
        resolve();
      };
      const onFirstError = (err: Error) => {
        reject(err);
      };
      this.opts.emitter.once('connect', onFirstConnect);
      this.opts.emitter.once('error', (err) => {
        this.opts.emitter.off('connect', onFirstConnect);
        onFirstError(err);
      });
      this.openSocket();
    });
  }

  private openSocket(): void {
    if (this.destroyed) return;

    const ws = new WebSocket(this.opts.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this._isConnected = true;
      ws.send(
        JSON.stringify({
          type: 'ready',
          instanceId: this.opts.instanceId,
          capabilities: this.opts.capabilities,
          timestamp: Date.now(),
        }),
      );
      this.opts.emitter.emit('connect');
    });

    ws.on('message', (data) => {
      try {
        const msg: WsMessage = JSON.parse(data.toString());
        this.opts.emitter.emit('message', msg);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', (code, reason) => {
      this._isConnected = false;
      this.opts.emitter.emit('disconnect', code, reason.toString());
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err) => {
      this.opts.emitter.emit('error', err);
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectAttempt >= this.opts.maxReconnectAttempts) return;

    const base = this.opts.reconnectBaseDelay;
    const capped = Math.min(base * Math.pow(2, this.reconnectAttempt), 30000);
    const jitter = capped * (0.8 + Math.random() * 0.4); // ±20%
    const delay = Math.round(jitter);

    this.reconnectAttempt++;
    this.opts.emitter.emit('reconnecting', this.reconnectAttempt, delay);

    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  send(msg: Partial<WsMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  destroy(): void {
    this.destroyed = true;
    this._isConnected = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this._isConnected;
  }
}
