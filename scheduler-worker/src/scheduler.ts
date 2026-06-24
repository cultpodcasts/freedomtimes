import { and, eq, sql } from 'drizzle-orm';
import { ApplicationServerKeys } from 'webpush-webcrypto';
import {
	buildArticlePushPayload,
	type PushNotificationPayload,
	type RecentPostForPush,
} from './articleNotificationPayload';
import {
	createApnsToken,
	createApplicationServerKeys,
	createGoogleAccessToken,
	deliverToStoredTarget,
	parseStoredTarget,
	readAndroidPushConfig,
	readIosPushConfig,
	readWebPushConfig,
} from './deliverPushNotification';
import { type AppDb, createDatabase, pushSubscriptionsTable, schedulerJobsTable, sentArticleNotificationsTable } from './db';

type Env = {
  TURSO_SCHEDULER_DATABASE_URL?: string;
  TURSO_SCHEDULER_AUTH_TOKEN?: string;
  TURSO_SUBSCRIPTIONS_DATABASE_URL?: string;
  TURSO_SUBSCRIPTIONS_AUTH_TOKEN?: string;
  PUSH_VAPID_PUBLIC_KEY?: string;
  PUSH_VAPID_PRIVATE_KEY?: string;
  PUSH_VAPID_SUBJECT?: string;
  PUSH_ANDROID_FCM_PROJECT_ID?: string;
  PUSH_ANDROID_FCM_CLIENT_EMAIL?: string;
  PUSH_ANDROID_FCM_PRIVATE_KEY?: string;
  PUSH_ANDROID_FCM_CHANNEL_ID?: string;
  PUSH_IOS_APNS_TEAM_ID?: string;
  PUSH_IOS_APNS_KEY_ID?: string;
  PUSH_IOS_APNS_PRIVATE_KEY?: string;
  PUSH_IOS_APNS_BUNDLE_ID?: string;
  PUSH_IOS_APNS_HOST?: string;
  NOTIFICATION_DEFAULT_TITLE?: string;
  NOTIFICATION_DEFAULT_URL?: string;
  PUBLISH_NOTIFICATION_DELAY_MINUTES?: string;
  SITE_ORIGIN?: string;
  PUSH_QUEUE?: Queue<QueuePushMessage>;
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

interface Queue<Message = any> {
  send(message: Message): Promise<void>;
  sendBatch(messages: { body: Message }[]): Promise<void>;
}

interface MessageBatch<Message = any> {
  queue: string;
  messages: {
    id: string;
    body: Message;
    retry(): void;
    ack(): void;
  }[];
}

type QueuePushMessage = {
  jobId: string;
  storedId: string;
  endpoint: string;
  subscriptionJson: string;
  payload: PushNotificationPayload;
};

const MAX_JOBS_PER_TICK = 25;

export default {
  async fetch(): Promise<Response> {
    return new Response('Scheduler worker is running.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },

  async queue(batch: MessageBatch<QueuePushMessage>, env: Env): Promise<void> {
    await processQueueBatch(batch, env);
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const databaseUrl = env.TURSO_SCHEDULER_DATABASE_URL?.trim();
    const authToken = env.TURSO_SCHEDULER_AUTH_TOKEN?.trim();

    if (!databaseUrl || !authToken) {
      throw new Error('TURSO_SCHEDULER_DATABASE_URL and TURSO_SCHEDULER_AUTH_TOKEN are required');
    }

    const { client, db } = createDatabase(databaseUrl, authToken);

    try {
      const jobs = await db.select({
        id: schedulerJobsTable.id,
        handler: schedulerJobsTable.handler,
        payload: schedulerJobsTable.payload,
        interval_minutes: schedulerJobsTable.intervalMinutes,
        next_run_at: schedulerJobsTable.nextRunAt,
      }).from(schedulerJobsTable)
        .where(sql`${schedulerJobsTable.active} = 1 AND datetime(${schedulerJobsTable.nextRunAt}) <= datetime('now')`)
        .orderBy(sql`datetime(${schedulerJobsTable.nextRunAt}) ASC`)
        .limit(MAX_JOBS_PER_TICK);

      if (jobs.length === 0) {
        console.log('[scheduler] cron tick: no due jobs (check scheduler_jobs in Turso: active=1 and next_run_at <= now)');
      } else {
        console.log(
          `[scheduler] cron tick: ${jobs.length} due job(s): ${jobs.map((j) => `${j.id}(${j.handler})`).join(', ')}`,
        );
      }

      for (const job of jobs) {
        const claim = await db.update(schedulerJobsTable)
          .set({
            nextRunAt: sql`datetime('now', '+' || ${schedulerJobsTable.intervalMinutes} || ' minutes')`,
            lastRunAt: sql`CURRENT_TIMESTAMP`,
            runCount: sql`${schedulerJobsTable.runCount} + 1`,
            lastError: null,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(and(
            eq(schedulerJobsTable.id, job.id),
            eq(schedulerJobsTable.active, 1),
            eq(schedulerJobsTable.nextRunAt, job.next_run_at),
          ))
          .run();

        if ((claim.rowsAffected ?? 0) < 1) {
          continue;
        }

        try {
          console.log(`[scheduler] ${job.id}: dispatch handler=${job.handler}`);
          await dispatchJob(job, env);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await db.update(schedulerJobsTable)
            .set({
              lastError: message,
              updatedAt: sql`CURRENT_TIMESTAMP`,
            })
            .where(eq(schedulerJobsTable.id, job.id))
            .run();
          throw error;
        }
      }
    } finally {
      client.close();
    }
  },
};

async function dispatchJob(job: SchedulerJob, env: Env): Promise<void> {
  const payload = parsePayload(job.payload);

  switch (job.handler) {

    case 'send_article_notifications': {
      await processArticleNotifications(job.id, env);
      return;
    }
    default:
      throw new Error(`Unsupported scheduler handler: ${job.handler}`);
  }
}

async function queueNotifications(
  jobId: string,
  payload: PushNotificationPayload,
  env: Env,
): Promise<number> {
  const subscriptionsDatabaseUrl = env.TURSO_SUBSCRIPTIONS_DATABASE_URL?.trim();
  const subscriptionsAuthToken = env.TURSO_SUBSCRIPTIONS_AUTH_TOKEN?.trim();

  if (!subscriptionsDatabaseUrl || !subscriptionsAuthToken) {
    throw new Error('TURSO_SUBSCRIPTIONS_DATABASE_URL and TURSO_SUBSCRIPTIONS_AUTH_TOKEN are required');
  }

  const pushQueue = env.PUSH_QUEUE;
  if (!pushQueue) {
    throw new Error('PUSH_QUEUE binding is missing');
  }

  const { client: subscriptionsClient, db: subscriptionsDb } = createDatabase(subscriptionsDatabaseUrl, subscriptionsAuthToken);

  try {
    let offset = 0;
    const batchSize = 1000;
    let queued = 0;

    while (true) {
      const subscriptions = await subscriptionsDb.select({
        id: pushSubscriptionsTable.id,
        endpoint: pushSubscriptionsTable.endpoint,
        subscription_json: pushSubscriptionsTable.subscriptionJson,
      }).from(pushSubscriptionsTable)
        .where(eq(pushSubscriptionsTable.active, 1))
        .orderBy(sql`datetime(${pushSubscriptionsTable.updatedAt}) DESC`)
        .limit(batchSize)
        .offset(offset);

      if (subscriptions.length === 0) {
        break;
      }

      const queueBatchSize = 100;
      for (let i = 0; i < subscriptions.length; i += queueBatchSize) {
        const chunk = subscriptions.slice(i, i + queueBatchSize);
        await pushQueue.sendBatch(chunk.map((stored) => ({
          body: {
            jobId,
            storedId: stored.id,
            endpoint: stored.endpoint,
            subscriptionJson: stored.subscription_json,
            payload,
          }
        })));
        queued += chunk.length;
      }

      offset += batchSize;
    }
    console.log(`[scheduler] ${jobId}: queued ${queued} notifications`);
    return queued;
  } finally {
    subscriptionsClient.close();
  }
}

async function processQueueBatch(batch: MessageBatch<QueuePushMessage>, env: Env): Promise<void> {
  const subscriptionsDatabaseUrl = env.TURSO_SUBSCRIPTIONS_DATABASE_URL?.trim();
  const subscriptionsAuthToken = env.TURSO_SUBSCRIPTIONS_AUTH_TOKEN?.trim();

  if (!subscriptionsDatabaseUrl || !subscriptionsAuthToken) {
    throw new Error('TURSO_SUBSCRIPTIONS_DATABASE_URL and TURSO_SUBSCRIPTIONS_AUTH_TOKEN are required');
  }

  const { client: subscriptionsClient, db: subscriptionsDb } = createDatabase(subscriptionsDatabaseUrl, subscriptionsAuthToken);
  const webPushConfig = readWebPushConfig(env);
  const androidPushConfig = readAndroidPushConfig(env);
  const iosPushConfig = readIosPushConfig(env);

  let applicationServerKeysPromise: Promise<ApplicationServerKeys> | null = null;
  let googleAccessTokenPromise: Promise<string> | null = null;
  let apnsTokenPromise: Promise<string> | null = null;

  try {
    for (const message of batch.messages) {
      const { jobId, storedId, endpoint, subscriptionJson, payload } = message.body;
      const target = parseStoredTarget(subscriptionJson);

      if (!target) {
        console.warn(`[scheduler] ${jobId}: invalid subscription payload id=${storedId} endpoint=${endpoint}`);
        await markSubscriptionFailure(subscriptionsDb, storedId, 'Invalid stored subscription payload', true);
        message.ack();
        continue;
      }

      try {
        const deliveryResult = await deliverToStoredTarget({
          target,
          payload,
          webPushConfig,
          androidPushConfig,
          iosPushConfig,
          getApplicationServerKeys: () => {
            if (!applicationServerKeysPromise) {
              applicationServerKeysPromise = createApplicationServerKeys(webPushConfig);
            }
            return applicationServerKeysPromise;
          },
          getGoogleAccessToken: () => {
            if (!googleAccessTokenPromise) {
              googleAccessTokenPromise = createGoogleAccessToken(androidPushConfig);
            }
            return googleAccessTokenPromise;
          },
          getApnsToken: () => {
            if (!apnsTokenPromise) {
              apnsTokenPromise = createApnsToken(iosPushConfig);
            }
            return apnsTokenPromise;
          },
        });

        if (deliveryResult.ok) {
          console.log(
            `[scheduler] ${jobId}: push delivered ok id=${storedId} platform=${target.platform} tag=${payload.tag}`,
          );
          await markSubscriptionSuccess(subscriptionsDb, storedId);
          message.ack();
          continue;
        }

        console.warn(
          `[scheduler] ${jobId}: delivery failed id=${storedId} endpoint=${endpoint} deactivate=${deliveryResult.deactivate} reason=${deliveryResult.reason ?? 'Push delivery failed'}`,
        );
        await markSubscriptionFailure(
          subscriptionsDb,
          storedId,
          deliveryResult.reason ?? 'Push delivery failed',
          deliveryResult.deactivate,
        );
        message.ack();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`[scheduler] ${jobId}: delivery exception id=${storedId} endpoint=${endpoint} reason=${errorMessage}`);
        await markSubscriptionFailure(subscriptionsDb, storedId, errorMessage, false);
        message.retry();
      }
    }
  } finally {
    subscriptionsClient.close();
  }
}

async function processArticleNotifications(jobId: string, env: Env): Promise<void> {
  const siteOrigin = env.SITE_ORIGIN?.trim() || 'https://freedomtimes.net';

  if (!readWebPushConfig(env)) {
    throw new Error('PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY, and PUSH_VAPID_SUBJECT are required for article notifications');
  }

  if (!env.PUSH_QUEUE) {
    throw new Error('PUSH_QUEUE binding is missing');
  }
  
  const delayStr = env.PUBLISH_NOTIFICATION_DELAY_MINUTES?.trim();
  if (!delayStr) {
    throw new Error('PUBLISH_NOTIFICATION_DELAY_MINUTES is required');
  }
  const delayMinutes = Number.parseInt(delayStr, 10);
  if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
    throw new Error(`PUBLISH_NOTIFICATION_DELAY_MINUTES must be a non-negative integer, got: ${delayStr}`);
  }

  const url = `${siteOrigin}/api/recent-published-posts.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch recent posts from ${url}: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { posts?: RecentPostForPush[] };
  if (!data.posts || !Array.isArray(data.posts)) {
    throw new Error('Invalid response format from recent posts API');
  }

  const subscriptionsDatabaseUrl = env.TURSO_SUBSCRIPTIONS_DATABASE_URL?.trim();
  const subscriptionsAuthToken = env.TURSO_SUBSCRIPTIONS_AUTH_TOKEN?.trim();

  if (!subscriptionsDatabaseUrl || !subscriptionsAuthToken) {
    throw new Error('TURSO_SUBSCRIPTIONS_DATABASE_URL and TURSO_SUBSCRIPTIONS_AUTH_TOKEN are required');
  }

  const { client: subscriptionsClient, db: subscriptionsDb } = createDatabase(subscriptionsDatabaseUrl, subscriptionsAuthToken);

  const thresholdDate = new Date(Date.now() - delayMinutes * 60 * 1000);
  const scan = {
    postsInFeed: data.posts.length,
    skippedNoPublishedAt: 0,
    skippedInvalidDate: 0,
    skippedTooNew: 0,
    skippedAlreadySent: 0,
    articlesQueued: 0,
  };

  try {
    console.log(
      `[scheduler] ${jobId}: article notification scan start url=${url} delayMinutes=${delayMinutes} threshold=${thresholdDate.toISOString()} postsInFeed=${scan.postsInFeed}`,
    );

    for (const post of data.posts) {
      if (!post.publishedAt) {
        scan.skippedNoPublishedAt++;
        continue;
      }

      const publishDate = new Date(post.publishedAt);
      if (Number.isNaN(publishDate.getTime())) {
        scan.skippedInvalidDate++;
        continue;
      }

      if (publishDate > thresholdDate) {
        scan.skippedTooNew++;
        continue;
      }

      const existing = await subscriptionsDb.select({ articleId: sentArticleNotificationsTable.articleId })
        .from(sentArticleNotificationsTable)
        .where(eq(sentArticleNotificationsTable.articleId, post.id))
        .limit(1);

      if (existing.length > 0) {
        scan.skippedAlreadySent++;
        continue;
      }

      const payload = buildArticlePushPayload(siteOrigin, post);

      console.log(`[scheduler] ${jobId}: sending notifications for article ${post.id}`);
      const queuedCount = await queueNotifications(jobId, payload, env);
      console.log(`[scheduler] ${jobId}: finished queuing for article ${post.id} (queued=${queuedCount})`);
      scan.articlesQueued++;

      // Mark only after the outbox queue accepted messages. Delivery is tracked per subscription;
      // failed article-level retries require removing this row (see web/scripts/reset-sent-article-notification.mjs).
      await subscriptionsDb.insert(sentArticleNotificationsTable).values({
        articleId: post.id,
        sentAt: sql`CURRENT_TIMESTAMP`,
      }).run();
    }

    console.log(`[scheduler] ${jobId}: article notification scan done ${JSON.stringify(scan)}`);
  } finally {
    subscriptionsClient.close();
  }
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

async function markSubscriptionSuccess(db: AppDb, id: string): Promise<void> {
  await db.update(pushSubscriptionsTable)
    .set({
      lastSuccessAt: sql`CURRENT_TIMESTAMP`,
      active: 1,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(pushSubscriptionsTable.id, id))
    .run();
}

async function markSubscriptionFailure(
  db: AppDb,
  id: string,
  reason: string,
  deactivate: boolean,
): Promise<void> {
  await db.update(pushSubscriptionsTable)
    .set({
      lastFailureAt: sql`CURRENT_TIMESTAMP`,
      lastFailureReason: reason.slice(0, 1000),
      active: deactivate ? 0 : 1,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(pushSubscriptionsTable.id, id))
    .run();
}
