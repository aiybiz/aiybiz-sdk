/**
 * Internal async push server.
 *
 * Runs inside the container on localhost:3099 (default).
 * Allows any process inside the container (crons, long tasks, scripts)
 * to push messages through the aiybiz WebSocket without a client request.
 *
 * Usage from a shell script or cron:
 *   curl -s -X POST http://localhost:3099/push \
 *     -H "Content-Type: application/json" \
 *     -d '{"content": "✅ Task completed", "meta": {"job": "scrape"}}'
 *
 * Usage from Node.js:
 *   await fetch('http://localhost:3099/push', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ content: 'Done!', meta: { result: 42 } })
 *   });
 *
 * Endpoints:
 *   POST /push    { content: string, meta?: object } → pulse via WebSocket
 *   GET  /health  → { ok: true, connected: boolean }
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { AiybizClient } from '../client.js';

const log = (msg: string) => console.log(`[aiybiz:push] ${new Date().toISOString()} ${msg}`);

export function startPushServer(client: AiybizClient, port = 3099, host = '127.0.0.1'): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, connected: client.isConnected }));
      return;
    }

    if (req.method === 'POST' && req.url === '/push') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { content, meta } = JSON.parse(body) as { content: string; meta?: Record<string, unknown> };
          if (!content || typeof content !== 'string') {
            throw new Error('"content" must be a non-empty string');
          }
          client.pulse(content, meta);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
          log(`pushed: ${content.slice(0, 80)}`);
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found. Use POST /push or GET /health' }));
  });

  server.listen(port, host, () => {
    log(`listening on http://${host}:${port}`);
    log('  POST /push   { content, meta? }  → push message via WebSocket');
    log('  GET  /health                     → connection status');
  });
}
