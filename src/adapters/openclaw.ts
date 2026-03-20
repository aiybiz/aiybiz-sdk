/**
 * OpenClaw adapter — bridges aiybiz messages to/from an OpenClaw gateway.
 *
 * OpenClaw exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * We maintain a per-session message history so the LLM has full context.
 */

export interface OpenClawAdapterOptions {
  /** URL of the OpenClaw gateway, e.g. http://localhost:18789 */
  gatewayUrl: string;
  /** Gateway auth token (gateway.auth.token in openclaw.json) */
  token: string;
  /** OpenClaw agent ID (default: "main") */
  agentId?: string;
  /** Max tokens per response (default: 2048) */
  maxTokens?: number;
  /** System prompt injected as the first message */
  systemPrompt?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const log = (label: string, msg: string) =>
  console.log(`[aiybiz:openclaw:${label}] ${new Date().toISOString()} ${msg}`);

const logErr = (label: string, msg: string) =>
  console.error(`[aiybiz:openclaw:${label}] ${new Date().toISOString()} ERROR ${msg}`);

export class OpenClawAdapter {
  private histories: Map<string, ChatMessage[]> = new Map();
  private opts: Required<OpenClawAdapterOptions>;

  constructor(opts: OpenClawAdapterOptions) {
    this.opts = {
      agentId: 'main',
      maxTokens: 2048,
      systemPrompt: 'You are a helpful AI assistant.',
      ...opts,
    };
    log('init', `adapter ready → ${this.opts.gatewayUrl} agent=${this.opts.agentId}`);
  }

  /**
   * Send a user message to OpenClaw and get the assistant reply.
   * @param sessionId  aiybiz session ID (used to track per-session history)
   * @param userMessage  the user's text
   */
  async chat(sessionId: string, userMessage: string): Promise<string> {
    const history = this.getOrCreateHistory(sessionId);
    history.push({ role: 'user', content: userMessage });

    const url = `${this.opts.gatewayUrl}/v1/chat/completions`;
    log(sessionId, `→ OpenClaw (${history.length} msgs in history): ${userMessage.slice(0, 80)}`);

    let raw: Response;
    try {
      raw = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.token}`,
          'x-openclaw-agent-id': this.opts.agentId,
        },
        body: JSON.stringify({
          model: `openclaw:${this.opts.agentId}`,
          messages: history,
          max_tokens: this.opts.maxTokens,
        }),
      });
    } catch (err) {
      logErr(sessionId, `fetch failed: ${(err as Error).message}`);
      throw new Error(`OpenClaw unreachable at ${url}: ${(err as Error).message}`);
    }

    if (!raw.ok) {
      const body = await raw.text().catch(() => '');
      logErr(sessionId, `HTTP ${raw.status}: ${body.slice(0, 200)}`);
      throw new Error(`OpenClaw returned HTTP ${raw.status}: ${body.slice(0, 200)}`);
    }

    const data = (await raw.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };

    if (data.error) {
      logErr(sessionId, `API error: ${data.error.message}`);
      throw new Error(`OpenClaw error: ${data.error.message}`);
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    if (!reply) {
      logErr(sessionId, 'empty reply from OpenClaw');
      throw new Error('OpenClaw returned an empty reply');
    }

    history.push({ role: 'assistant', content: reply });
    log(sessionId, `← OpenClaw reply (${reply.length} chars): ${reply.slice(0, 80)}`);
    return reply;
  }

  /** Reset the conversation history for a session */
  clearHistory(sessionId: string): void {
    this.histories.delete(sessionId);
    log(sessionId, 'history cleared');
  }

  private getOrCreateHistory(sessionId: string): ChatMessage[] {
    if (!this.histories.has(sessionId)) {
      const history: ChatMessage[] = [];
      if (this.opts.systemPrompt) {
        history.push({ role: 'system', content: this.opts.systemPrompt });
      }
      this.histories.set(sessionId, history);
      log(sessionId, 'new conversation history created');
    }
    return this.histories.get(sessionId)!;
  }
}
