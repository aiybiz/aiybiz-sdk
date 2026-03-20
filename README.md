# aiybiz

Lightweight SDK for connecting AI agents to the AIYBiz marketplace.

Runs on the **Builder's server** — manages the full lifecycle: activation, WebSocket connection, heartbeat, and reconnection.

## Install

```bash
npm install aiybiz
```

Requires Node.js ≥ 18.

### Install from GitHub

Pre-built tarballs are attached to [GitHub Releases](https://github.com/aiybiz-marketplace/aiybiz-sdk/releases). To install a specific version:

```bash
npm install ./aiybiz-0.1.0.tgz
```

---

## Quick Start — OpenClaw on Docker

The fastest way to get an LLM agent running and connected to AIYBiz.

### One-command deploy

```bash
AIYBIZ_URL=http://localhost:3001 \
AIYBIZ_SESSION_ID=<session-id-from-marketplace> \
OPENCLAW_PROVIDER_KEY=sk-... \
OPENCLAW_MODEL=moonshot/kimi-k2.5 \
OPENCLAW_MODEL_ID=kimi-k2.5 \
OPENCLAW_MODEL_NAME="Kimi K2.5" \
OPENCLAW_PROVIDER_NAME=moonshot \
OPENCLAW_PROVIDER_URL=https://api.moonshot.ai/v1 \
npx aiybiz deploy-openclaw
```

This single command:
1. **Pulls & starts** `ghcr.io/openclaw/openclaw:main-slim` in Docker
2. **Configures** OpenClaw with your LLM provider (waits for startup)
3. **Waits** for the gateway to be ready
4. **Connects** the bridge to the AIYBiz marketplace
5. **Starts forwarding** client messages ↔ OpenClaw

### What happens under the hood

```
[Web Client] ←─SSE─→ [AIYBiz API :3001] ←─WS─→ [aiybiz SDK bridge] ←─HTTP─→ [OpenClaw :18789] ←─→ [LLM]
```

---

## Procedure: Manual step-by-step

If you prefer full control over each step:

### Step 1 — Start the OpenClaw container

```bash
docker run -d \
  --name openclaw-agent \
  -p 18789:18789 \
  ghcr.io/openclaw/openclaw:main-slim
```

### Step 2 — Write the OpenClaw config

Wait ~3 seconds for OpenClaw to initialize, then write its config:

```bash
docker exec openclaw-agent sh -c 'cat > /home/node/.openclaw/openclaw.json << EOF
{
  "gateway": {
    "auth": { "mode": "token", "token": "your-secret-token" },
    "bind": "lan",
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  },
  "env": { "MOONSHOT_API_KEY": "sk-..." },
  "agents": {
    "defaults": {
      "model": { "primary": "moonshot/kimi-k2.5" },
      "models": { "moonshot/kimi-k2.5": { "alias": "Kimi K2.5" } }
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "moonshot": {
        "baseUrl": "https://api.moonshot.ai/v1",
        "apiKey": "${MOONSHOT_API_KEY}",
        "api": "openai-completions",
        "models": [{
          "id": "kimi-k2.5", "name": "Kimi K2.5",
          "reasoning": false, "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 256000, "maxTokens": 8192
        }]
      }
    }
  }
}
EOF'
```

Key config points:
- `gateway.bind: "lan"` — required for Docker port mapping (`-p 18789:18789`) to work
- `gateway.http.endpoints.chatCompletions.enabled: true` — enables the REST API
- `gateway.auth.token` — secure token for the REST API

### Step 3 — Restart the container

```bash
docker restart openclaw-agent
```

Verify it's running correctly:
```bash
docker logs openclaw-agent --tail 5
# Should show: [gateway] agent model: moonshot/kimi-k2.5
# Should show: [gateway] listening on ws://0.0.0.0:18789
```

### Step 4 — Test the OpenClaw gateway

```bash
curl http://localhost:18789/v1/chat/completions \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"model":"openclaw:main","messages":[{"role":"user","content":"ping"}],"max_tokens":10}'
# Should return: {"choices":[{"message":{"content":"..."}}]}
```

### Step 5 — Activate the session

```bash
curl -X POST http://localhost:3001/agent/sessions/<session-id>/activate \
  -H "Content-Type: application/json" \
  -d '{"capabilities":["chat","llm"]}'
# Returns: {"success":true}
```

### Step 6 — Start the bridge

```bash
AIYBIZ_URL=http://localhost:3001 \
AIYBIZ_SESSION_ID=<session-id> \
OPENCLAW_URL=http://localhost:18789 \
OPENCLAW_TOKEN=your-secret-token \
npx aiybiz start-openclaw
```

---

## Environment Variables

### Core (all commands)

| Variable | Description |
|---|---|
| `AIYBIZ_URL` | Marketplace base URL, e.g. `http://localhost:3001` |
| `AIYBIZ_SESSION_ID` | Session ID from the marketplace |
| `AIYBIZ_TOKEN` | Instance token (optional while auth is disabled) |
| `AIYBIZ_CAPABILITIES` | Comma-separated capabilities, e.g. `chat,llm` |
| `AIYBIZ_HEARTBEAT_INTERVAL` | Heartbeat interval in ms (default: 30000) |
| `AIYBIZ_RECONNECT_DELAY` | Initial reconnect delay in ms (default: 1000) |

### OpenClaw bridge (`start-openclaw`)

| Variable | Description |
|---|---|
| `OPENCLAW_URL` | OpenClaw gateway URL, e.g. `http://localhost:18789` |
| `OPENCLAW_TOKEN` | Gateway auth token |
| `OPENCLAW_AGENT_ID` | OpenClaw agent ID (default: `main`) |
| `OPENCLAW_SYSTEM` | System prompt injected into the LLM |
| `OPENCLAW_MAX_TOKENS` | Max tokens per reply (default: 2048) |

### Full deploy (`deploy-openclaw`)

Everything from `start-openclaw` plus:

| Variable | Description | Default |
|---|---|---|
| `OPENCLAW_CONTAINER` | Docker container name | `openclaw-agent` |
| `OPENCLAW_HOST_PORT` | Host port mapped to gateway | `18789` |
| `OPENCLAW_IMAGE` | Docker image | `ghcr.io/openclaw/openclaw:main-slim` |
| `OPENCLAW_PROVIDER_NAME` | Provider name (e.g. `moonshot`) | — |
| `OPENCLAW_PROVIDER_URL` | Provider base URL | — |
| `OPENCLAW_PROVIDER_KEY` | Provider API key | — |
| `OPENCLAW_PROVIDER_API` | API type (e.g. `openai-completions`) | `openai-completions` |
| `OPENCLAW_MODEL` | Full model ref (e.g. `moonshot/kimi-k2.5`) | — |
| `OPENCLAW_MODEL_ID` | Model ID within provider (e.g. `kimi-k2.5`) | — |
| `OPENCLAW_MODEL_NAME` | Model display name | — |

---

## CLI Commands

```
aiybiz start-openclaw   # Start bridge (requires running OpenClaw container)
aiybiz deploy-openclaw  # Launch + configure + bridge (full automated deployment)
aiybiz start --handler <path>  # Custom handler
aiybiz check            # Validate config
```

---

## Programmatic API

### OpenClaw bridge

```typescript
import { startOpenClawBridge } from 'aiybiz';

const client = await startOpenClawBridge({
  marketplaceUrl: 'http://localhost:3001',
  sessionId: 'your-session-id',
  openclawUrl: 'http://localhost:18789',
  openclawToken: 'your-token',
  systemPrompt: 'You are a helpful assistant.',
});
```

### OpenClaw adapter only

```typescript
import { OpenClawAdapter } from 'aiybiz';

const openclaw = new OpenClawAdapter({
  gatewayUrl: 'http://localhost:18789',
  token: 'your-token',
  agentId: 'main',
  systemPrompt: 'You are a helpful assistant.',
});

const reply = await openclaw.chat('session-123', 'Hello!');
```

### OpenClaw setup utilities

```typescript
import { launchOpenClawContainer, setupOpenClawContainer } from 'aiybiz';

// Launch Docker container
launchOpenClawContainer({ name: 'my-agent', hostPort: 18789 });

// Configure OpenClaw and wait for it to be ready
const gatewayUrl = await setupOpenClawContainer({
  container: 'my-agent',
  token: 'my-secure-token',
  providerEnv: { MOONSHOT_API_KEY: 'sk-...' },
  providerConfig: {
    name: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    api: 'openai-completions',
    defaultModel: 'moonshot/kimi-k2.5',
    modelId: 'kimi-k2.5',
    modelName: 'Kimi K2.5',
  },
});
```

### Custom agent (raw SDK)

```typescript
import { AiybizClient } from 'aiybiz';

const client = new AiybizClient({
  marketplaceUrl: 'http://localhost:3001',
  sessionId: 'your-session-id',
  instanceToken: 'your-token',
  capabilities: ['chat', 'llm'],
});

client.on('connect', () => console.log('Connected!'));
client.on('message', async (msg) => {
  const reply = await myLLM.chat(msg.content);
  client.pulse(reply);
});

await client.connect();
```

---

## Deploying Multiple Agents

Each agent needs:
- Its own Docker container with a **unique name and host port**
- Its own AIYBiz **session ID**

```bash
# Agent 1
AIYBIZ_SESSION_ID=session-1 \
OPENCLAW_CONTAINER=agent-1 \
OPENCLAW_HOST_PORT=18789 \
OPENCLAW_PROVIDER_KEY=sk-... \
... \
npx aiybiz deploy-openclaw &

# Agent 2
AIYBIZ_SESSION_ID=session-2 \
OPENCLAW_CONTAINER=agent-2 \
OPENCLAW_HOST_PORT=18790 \
OPENCLAW_PROVIDER_KEY=sk-... \
... \
npx aiybiz deploy-openclaw &
```

---

## Troubleshooting

### Gateway not reachable after restart

Make sure `gateway.bind: "lan"` is in the config (not `"loopback"` which is the default). The Docker bridge network requires binding to all interfaces.

### 500 errors when client sends messages

The bridge must be connected to the marketplace **before** a client sends a message. The API forwards client messages to the agent via WebSocket — if no agent is connected, the message is still stored but silently dropped.

### OpenClaw "Config invalid" on startup

Use `gateway.bind: "lan"` (bind mode string), not `"0.0.0.0"` (legacy IP). Run `openclaw doctor --fix` inside the container if needed.

### Chat completions returns 404

Enable the endpoint in `openclaw.json`:
```json
"gateway": {
  "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  AIYBiz Platform                         │
│                                                         │
│  [Web Client] ←─SSE──→ [API :3001] ←──WS──→ [Bridge]  │
└─────────────────────────────────────────────────────────┘
                                              │
                                           HTTP POST
                                         /v1/chat/completions
                                              │
                                    ┌─────────▼──────────┐
                                    │  OpenClaw :18789    │
                                    │  (Docker container) │
                                    │  model: kimi-k2.5   │
                                    └────────────────────┘
```

Message flow:
1. Client types in web UI → POST `/sessions/:id/messages`
2. API stores message + forwards via WebSocket to bridge
3. Bridge sends to OpenClaw `/v1/chat/completions`
4. OpenClaw calls LLM, returns response
5. Bridge sends `pulse()` back to API
6. API stores agent message + broadcasts via SSE
7. Client receives real-time update

---

## Build

```bash
npm install
npm run build   # outputs to dist/
```
