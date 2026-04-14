// Cloudflare Worker: Scheduler Cron Job
// This worker polls the scheduler_jobs table and dispatches notification events

import { LibsqlError, createClient } from '@libsql/client/web';

const DB_URL = process.env.TURSO_STAGING_SCHEDULER_DB_URL;
const DB_TOKEN = process.env.TURSO_STAGING_SCHEDULER_DB_TOKEN;

const db = createClient({ url: DB_URL, authToken: DB_TOKEN });

export default {
  async scheduled(event: ScheduledEvent, env: any, ctx: any) {
    // Find the next pending job
    const now = new Date().toISOString();
    const { rows } = await db.execute(
      `SELECT * FROM scheduler_jobs WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT 1`,
      [now]
    );
    if (!rows.length) return;
    const job = rows[0];

    // Dispatch to handler
    if (job.type === 'send_notification') {
      await sendNotification(job);
    }

    // Mark as completed
    await db.execute(
      `UPDATE scheduler_jobs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [job.id]
    );
  },
};

async function sendNotification(job: any) {
  // For demo: just log the notification payload
  // Replace with actual notification logic
  const payload = JSON.parse(job.payload || '{}');
  console.log('Sending notification:', payload.message);
}
