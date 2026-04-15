export interface AiybizConfig {
  /** Base URL of the marketplace, e.g. https://api.aiybiz.com */
  marketplaceUrl: string;

  /** Session ID provided by the marketplace during provisioning */
  sessionId: string;

  /** Instance token provided by the marketplace during provisioning */
  instanceToken: string;

  /** Declared capabilities of this agent */
  capabilities?: string[];

  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;

  /** Initial reconnect delay in ms (default: 1000) */
  reconnectBaseDelay?: number;

  /** Max reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}

export interface ActivateResponse {
  success: boolean;
}

export type MessageType = 'ready' | 'heartbeat' | 'message' | 'pulse' | 'error';

export interface WsMessage {
  type: MessageType;
  instanceId?: string;
  from?: string;
  to?: string;
  content?: string;
  attachments?: Attachment[];
  meta?: Record<string, unknown>;
  timestamp?: number;
}

export interface Attachment {
  name: string;
  url: string;
  mimeType?: string;
  size?: number;
}

export interface AiybizEventMap {
  connect: () => void;
  disconnect: (code: number, reason: string) => void;
  message: (msg: WsMessage) => void;
  error: (err: Error) => void;
  reconnecting: (attempt: number, delay: number) => void;
}

/** Values accepted by `PUT /agent/sessions/:sessionId/cron-jobs` for `lastRunState`. */
export type AgentCronLastRunState = 'running' | 'success' | 'failed' | null;

/**
 * One cron job row for agent → marketplace sync (`PUT .../cron-jobs` request body).
 * Call periodically with stable `id`s; empty array clears all jobs server-side.
 */
export interface AgentCronJobBody {
  id: string;
  title: string;
  description: string;
  prompt: string;
  schedule: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunState: AgentCronLastRunState;
}

/** Job as returned after a successful cron-jobs replace (includes empty `executions`). */
export interface AgentCronJobRow extends AgentCronJobBody {
  executions: unknown[];
}
