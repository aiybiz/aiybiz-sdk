import { WsManager } from './ws';

export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private wsManager: WsManager,
    private intervalMs: number,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.wsManager.send({ type: 'heartbeat', timestamp: Date.now() });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
