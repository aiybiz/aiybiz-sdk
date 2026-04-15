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
 *   POST /push       { content: string, meta?: object }  → pulse via WebSocket
 *   GET  /health                                         → connection status
 *   GET  /crons                                          → list OpenClaw cron jobs
 *   GET  /crons/:id/runs                                 → run history for a job
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import type { AiybizClient } from '../client.js';
import type { CronJob } from './openclaw-cron-state';
import { readCronJobs, readCronRuns } from './openclaw-cron-state';

function formatCronJob(job: CronJob) {
  return {
    id: job.id,
    name: job.name ?? null,
    description: job.description ?? null,
    enabled: job.enabled,
    schedule: job.schedule,
    payload: job.payload ?? null,
    nextRunAt: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : null,
    lastRunAt: job.state?.lastRunAtMs ? new Date(job.state.lastRunAtMs).toISOString() : null,
    lastRunSuccess: job.state?.lastRunSuccess ?? null,
    runCount: job.state?.runCount ?? 0,
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
  };
}

const log = (msg: string) => console.log(`[aiybiz:push] ${new Date().toISOString()} ${msg}`);

export function startPushServer(client: AiybizClient, port = 3099, host = '127.0.0.1'): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, connected: client.isConnected }));
      return;
    }

    // GET /crons — list all OpenClaw cron jobs
    if (req.method === 'GET' && req.url === '/crons') {
      const jobs = readCronJobs();
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, jobs: jobs.map(formatCronJob) }));
      return;
    }

    // GET /crons/:id/runs — run history for a specific job
    const runsMatch = req.url?.match(/^\/crons\/([^/]+)\/runs$/);
    if (req.method === 'GET' && runsMatch) {
      const jobId = runsMatch[1];
      const jobs = readCronJobs();
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Job ${jobId} not found` }));
        return;
      }
      const runs = readCronRuns(jobId);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, jobId, runs }));
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
    log('  POST /push        { content, meta? }  → push message via WebSocket');
    log('  GET  /health                          → connection status');
    log('  GET  /crons                           → list OpenClaw cron jobs');
    log('  GET  /crons/:id/runs                  → run history for a job');
  });
}
