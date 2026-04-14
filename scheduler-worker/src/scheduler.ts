import { createClient } from '@libsql/client';
import { ApplicationServerKeys, generatePushHTTPRequest } from 'webpush-webcrypto';

type Env = {
  TURSO_SCHEDULER_DATABASE_URL?: string;
  TURSO_SCHEDULER_AUTH_TOKEN?: string;
  TURSO_SUBSCRIPTIONS_DATABASE_URL?: string;
  TURSO_SUBSCRIPTIONS_AUTH_TOKEN?: string;
  PUSH_VAPID_PUBLIC_KEY?: string;
  PUSH_VAPID_PRIVATE_KEY?: string;
  PUSH_VAPID_SUBJECT?: string;
  NOTIFICATION_DEFAULT_TITLE?: string;
  NOTIFICATION_DEFAULT_URL?: string;
};

type SchedulerJob = {
  id: string;
  handler: string;
  payload: string;
  interval_minutes: number;
  next_run_at: string;
};

type StoredPushSubscription = {
  id: string;
  endpoint: string;
  subscription_json: string;
};

type PushTarget = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type PushNotificationPayload = {
  title: string;
  body: string;
  url: string;
  icon: string;
  badge: string;
  tag: string;
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
};

const MAX_JOBS_PER_TICK = 25;
const MAX_SUBSCRIPTIONS_PER_JOB = 500;

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
      const summary = await deliverNotification(job.id, toPushNotificationPayload(payload, env), env);
      console.log(`[scheduler] ${job.id}: delivered=${summary.delivered} failed=${summary.failed} deactivated=${summary.deactivated}`);
      return;
    }
    default:
      throw new Error(`Unsupported scheduler handler: ${job.handler}`);
  }
}

async function deliverNotification(
  jobId: string,
  payload: PushNotificationPayload,
  env: Env,
): Promise<{ delivered: number; failed: number; deactivated: number }> {
  const subscriptionsDatabaseUrl = env.TURSO_SUBSCRIPTIONS_DATABASE_URL?.trim();
  const subscriptionsAuthToken = env.TURSO_SUBSCRIPTIONS_AUTH_TOKEN?.trim();

  if (!subscriptionsDatabaseUrl || !subscriptionsAuthToken) {
    throw new Error('TURSO_SUBSCRIPTIONS_DATABASE_URL and TURSO_SUBSCRIPTIONS_AUTH_TOKEN are required');
  }

  const vapidPublicKey = env.PUSH_VAPID_PUBLIC_KEY?.trim();
  const vapidPrivateKey = env.PUSH_VAPID_PRIVATE_KEY?.trim();
  const vapidSubject = env.PUSH_VAPID_SUBJECT?.trim();

  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    throw new Error('PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY, and PUSH_VAPID_SUBJECT are required');
  }

  const subscriptionsDb = createClient({ url: subscriptionsDatabaseUrl, authToken: subscriptionsAuthToken });
  const applicationServerKeys = await ApplicationServerKeys.fromJSON({
    publicKey: vapidPublicKey,
    privateKey: vapidPrivateKey,
  });

  let delivered = 0;
  let failed = 0;
  let deactivated = 0;

  try {
    const result = await subscriptionsDb.execute({
      sql: `
        SELECT id, endpoint, subscription_json
        FROM push_subscriptions
        WHERE active = 1
        ORDER BY datetime(updated_at) DESC
        LIMIT ?
      `,
      args: [MAX_SUBSCRIPTIONS_PER_JOB],
    });

    if (result.rows.length === 0) {
      console.log(`[scheduler] ${jobId}: no active push subscriptions`);
      return { delivered, failed, deactivated };
    }

    for (const row of result.rows) {
      const stored = toStoredPushSubscription(row);
      const target = parseStoredTarget(stored.subscription_json);

      if (!target) {
        failed += 1;
        deactivated += 1;
        await markSubscriptionFailure(subscriptionsDb, stored.id, 'Invalid stored subscription payload', true);
        continue;
      }

      try {
        const request = await generatePushHTTPRequest({
          applicationServerKeys,
          payload: JSON.stringify(payload),
          target,
          adminContact: vapidSubject,
          ttl: payload.ttl,
          urgency: payload.urgency,
          topic: payload.tag,
        });

        const response = await fetch(request.endpoint, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
        });

        if (response.ok) {
          delivered += 1;
          await markSubscriptionSuccess(subscriptionsDb, stored.id);
          continue;
        }

        failed += 1;
        const deactivate = response.status === 404 || response.status === 410;
        if (deactivate) {
          deactivated += 1;
        }

        const responseText = await safeReadResponseText(response);
        await markSubscriptionFailure(
          subscriptionsDb,
          stored.id,
          `Push service responded ${response.status}${responseText ? `: ${responseText}` : ''}`,
          deactivate,
        );
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        await markSubscriptionFailure(subscriptionsDb, stored.id, message, false);
      }
    }

    return { delivered, failed, deactivated };
  } finally {
    subscriptionsDb.close();
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

function toStoredPushSubscription(row: Record<string, unknown>): StoredPushSubscription {
  return {
    id: String(row.id ?? ''),
    endpoint: String(row.endpoint ?? ''),
    subscription_json: String(row.subscription_json ?? '{}'),
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

function parseStoredTarget(rawSubscription: string): PushTarget | null {
  try {
    const parsed = JSON.parse(rawSubscription) as Record<string, unknown>;
    const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : '';
    const keys = parsed.keys;

    if (!endpoint || !keys || typeof keys !== 'object') {
      return null;
    }

    const parsedKeys = keys as Record<string, unknown>;
    const p256dh = typeof parsedKeys.p256dh === 'string' ? parsedKeys.p256dh.trim() : '';
    const auth = typeof parsedKeys.auth === 'string' ? parsedKeys.auth.trim() : '';

    if (!p256dh || !auth) {
      return null;
    }

    return {
      endpoint,
      keys: { p256dh, auth },
    };
  } catch {
    return null;
  }
}

function toPushNotificationPayload(payload: Record<string, unknown>, env: Env): PushNotificationPayload {
  return {
    title: readTrimmedString(payload.title) || env.NOTIFICATION_DEFAULT_TITLE?.trim() || 'Freedom Times',
    body: readTrimmedString(payload.body) || readTrimmedString(payload.message) || 'Scheduled notification',
    url: readTrimmedString(payload.url) || env.NOTIFICATION_DEFAULT_URL?.trim() || '/',
    icon: readTrimmedString(payload.icon) || '/favicon.svg',
    badge: readTrimmedString(payload.badge) || '/favicon.svg',
    tag: readTrimmedString(payload.tag) || 'freedomtimes-notification',
    ttl: readPositiveInteger(payload.ttl) || 3600,
    urgency: readUrgency(payload.urgency),
  };
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function readUrgency(value: unknown): PushNotificationPayload['urgency'] {
  return value === 'very-low' || value === 'low' || value === 'normal' || value === 'high'
    ? value
    : 'high';
}

async function markSubscriptionSuccess(db: ReturnType<typeof createClient>, id: string): Promise<void> {
  await db.execute({
    sql: `
      UPDATE push_subscriptions
      SET last_success_at = CURRENT_TIMESTAMP,
          last_failure_at = NULL,
          last_failure_reason = NULL,
          active = 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    args: [id],
  });
}

async function markSubscriptionFailure(
  db: ReturnType<typeof createClient>,
  id: string,
  reason: string,
  deactivate: boolean,
): Promise<void> {
  await db.execute({
    sql: `
      UPDATE push_subscriptions
      SET last_failure_at = CURRENT_TIMESTAMP,
          last_failure_reason = ?,
          active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    args: [reason.slice(0, 1000), deactivate ? 0 : 1, id],
  });
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return '';
  }
}
