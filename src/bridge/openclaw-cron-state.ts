import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentCronJobBody, AgentCronLastRunState } from '../types';

/** OpenClaw `cron/jobs.json` schedule shapes */
export type CronSchedule =
  | { kind: 'cron'; expr: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'once'; atMs: number };

export type CronJob = {
  id: string;
  name?: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  payload?: { kind: string; message?: string };
  state?: {
    nextRunAtMs?: number | null;
    lastRunAtMs?: number | null;
    lastRunSuccess?: boolean | null;
    runCount?: number;
  };
};

export type CronJobsFile = { version: number; jobs: CronJob[] };

export type CronRun = {
  id?: string;
  jobId?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  success?: boolean;
  error?: string;
};

export function getOpenClawStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw');
}

export function readCronJobs(): CronJob[] {
  try {
    const filePath = join(getOpenClawStateDir(), 'cron', 'jobs.json');
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as CronJobsFile;
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return [];
  }
}

export function readCronRuns(jobId: string): CronRun[] {
  try {
    const runsDir = join(getOpenClawStateDir(), 'cron', 'runs');
    const files = readdirSync(runsDir).filter((f) => f.endsWith('.jsonl'));
    const runs: CronRun[] = [];
    for (const file of files) {
      const content = readFileSync(join(runsDir, file), 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const run = JSON.parse(line) as CronRun;
          if (!jobId || run.jobId === jobId) runs.push(run);
        } catch { /* skip malformed lines */ }
      }
    }
    return runs.sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
  } catch {
    return [];
  }
}

function scheduleToCronExpression(schedule: CronSchedule): string {
  if (schedule.kind === 'cron') return schedule.expr;
  if (schedule.kind === 'every') {
    const ms = schedule.everyMs;
    if (ms < 60_000) return '* * * * *';
    const mins = Math.max(1, Math.round(ms / 60_000));
    if (mins <= 59) return `*/${mins} * * * *`;
    const hours = Math.max(1, Math.round(mins / 60));
    return `0 */${hours} * * *`;
  }
  const d = new Date(schedule.atMs);
  return `${d.getUTCMinutes()} ${d.getUTCHours()} ${d.getUTCDate()} ${d.getUTCMonth() + 1} *`;
}

function openClawLastRunState(job: CronJob): AgentCronLastRunState {
  const s = job.state;
  if (s?.lastRunAtMs == null) return null;
  if (s.lastRunSuccess === true) return 'success';
  if (s.lastRunSuccess === false) return 'failed';
  return null;
}

/**
 * Maps a local OpenClaw cron row to the marketplace `PUT .../cron-jobs` job shape.
 */
export function mapCronJobToAgentBody(job: CronJob): AgentCronJobBody {
  const msg = job.payload?.message;
  const prompt = typeof msg === 'string' ? msg : '';
  return {
    id: job.id,
    title: (job.name?.trim() || 'Cron job').slice(0, 500),
    description: job.description ?? '',
    prompt,
    schedule: scheduleToCronExpression(job.schedule),
    nextRunAt: job.state?.nextRunAtMs != null ? new Date(job.state.nextRunAtMs).toISOString() : null,
    lastRunAt: job.state?.lastRunAtMs != null ? new Date(job.state.lastRunAtMs).toISOString() : null,
    lastRunState: openClawLastRunState(job),
  };
}

const DEFAULT_MAX_AGENT_CRON_JOBS = 100;

/**
 * Builds the `jobs` array for `PUT /agent/sessions/:sessionId/cron-jobs`.
 * De-duplicates by `id` (first occurrence wins). Truncates to `maxJobs` (API max 100).
 */
export function buildAgentCronJobsPayload(
  openClawJobs: CronJob[],
  opts?: { maxJobs?: number },
): AgentCronJobBody[] {
  const maxJobs = Math.min(opts?.maxJobs ?? DEFAULT_MAX_AGENT_CRON_JOBS, DEFAULT_MAX_AGENT_CRON_JOBS);
  const seen = new Set<string>();
  const out: AgentCronJobBody[] = [];
  for (const job of openClawJobs) {
    if (!job.id || seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(mapCronJobToAgentBody(job));
    if (out.length >= maxJobs) break;
  }
  return out;
}
