import { createClient } from '@libsql/client';

type Env = {
  TURSO_SCHEDULER_DATABASE_URL?: string;
  TURSO_SCHEDULER_AUTH_TOKEN?: string;
  NOTIFICATION_DEFAULT_TITLE?: string;
};

type SchedulerJob = {
  id: string;
  handler: string;
  payload: string;
  interval_minutes: number;
  next_run_at: string;
};

const MAX_JOBS_PER_TICK = 25;

export default {
  async fetch(): Promise<Response> {
    return new Response('Scheduler worker is running.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const databaseUrl = env.TURSO_SCHEDULER_DATABASE_URL?.trim();
    const authToken = env.TURSO_SCHEDULER_AUTH_TOKEN?.trim();

    if (!databaseUrl || !authToken) {
      throw new Error('TURSO_SCHEDULER_DATABASE_URL and TURSO_SCHEDULER_AUTH_TOKEN are required');
    }

    const db = createClient({ url: databaseUrl, authToken });

    try {
      const result = await db.execute({
        sql: `
          SELECT id, handler, payload, interval_minutes, next_run_at
          FROM scheduler_jobs
          WHERE active = 1
            AND datetime(next_run_at) <= datetime('now')
          ORDER BY datetime(next_run_at) ASC
          LIMIT ?
        `,
        args: [MAX_JOBS_PER_TICK],
      });

      for (const row of result.rows) {
        const job = toSchedulerJob(row);
        const claim = await db.execute({
          sql: `
            UPDATE scheduler_jobs
            SET next_run_at = datetime('now', '+' || interval_minutes || ' minutes'),
                last_run_at = CURRENT_TIMESTAMP,
                run_count = run_count + 1,
                last_error = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND active = 1
              AND next_run_at = ?
          `,
          args: [job.id, job.next_run_at],
        });

        if ((claim.rowsAffected ?? 0) < 1) {
          continue;
        }

        try {
          await dispatchJob(job, env);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await db.execute({
            sql: `
              UPDATE scheduler_jobs
              SET last_error = ?,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `,
            args: [message, job.id],
          });
          throw error;
        }
      }
    } finally {
      db.close();
    }
  },
};

async function dispatchJob(job: SchedulerJob, env: Env): Promise<void> {
  const payload = parsePayload(job.payload);

  switch (job.handler) {
    case 'send_hardcoded_notification': {
      const title = typeof payload.title === 'string' && payload.title ? payload.title : env.NOTIFICATION_DEFAULT_TITLE ?? 'Freedom Times';
      const message = typeof payload.message === 'string' && payload.message ? payload.message : 'Scheduled notification';
      console.log(`[scheduler] ${job.id}: ${title} - ${message}`);
      return;
    }
    default:
      throw new Error(`Unsupported scheduler handler: ${job.handler}`);
  }
}

function toSchedulerJob(row: Record<string, unknown>): SchedulerJob {
  return {
    id: String(row.id ?? ''),
    handler: String(row.handler ?? ''),
    payload: String(row.payload ?? '{}'),
    interval_minutes: Number(row.interval_minutes ?? 0),
    next_run_at: String(row.next_run_at ?? ''),
  };
}

function parsePayload(rawPayload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore invalid payloads and fall back to an empty object.
  }

  return {};
}
