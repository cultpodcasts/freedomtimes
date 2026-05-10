import { and, eq, sql } from 'drizzle-orm';
import { importPKCS8, SignJWT } from 'jose';
import { ApplicationServerKeys, generatePushHTTPRequest } from 'webpush-webcrypto';
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

type PushTarget = {
  platform: 'web';
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

type AndroidPushTarget = {
  platform: 'android';
  token: string;
};

type IosPushTarget = {
  platform: 'ios';
  token: string;
};

type StoredNotificationTarget = PushTarget | AndroidPushTarget | IosPushTarget;

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

type DeliveryResult = {
  ok: boolean;
  deactivate: boolean;
  reason?: string;
};

type WebPushConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

type AndroidPushConfig = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  channelId: string;
};

type IosPushConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
  host: string;
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
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';
const DEFAULT_ANDROID_CHANNEL_ID = 'reader-alerts';
const DEFAULT_IOS_APNS_HOST = 'api.push.apple.com';

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
): Promise<void> {
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
  
  const delayStr = env.PUBLISH_NOTIFICATION_DELAY_MINUTES?.trim();
  if (!delayStr) {
    throw new Error('PUBLISH_NOTIFICATION_DELAY_MINUTES is required');
  }
  const delayMinutes = Number.parseInt(delayStr, 10);

  const url = `${siteOrigin}/api/recent-published-posts.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch recent posts from ${url}: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { posts?: { id: string; slug: string; title: string; excerpt: string | null; publishedAt: string | null }[] };
  if (!data.posts || !Array.isArray(data.posts)) {
    throw new Error('Invalid response format from recent posts API');
  }

  const subscriptionsDatabaseUrl = env.TURSO_SUBSCRIPTIONS_DATABASE_URL?.trim();
  const subscriptionsAuthToken = env.TURSO_SUBSCRIPTIONS_AUTH_TOKEN?.trim();

  if (!subscriptionsDatabaseUrl || !subscriptionsAuthToken) {
    throw new Error('TURSO_SUBSCRIPTIONS_DATABASE_URL and TURSO_SUBSCRIPTIONS_AUTH_TOKEN are required');
  }

  const { client: subscriptionsClient, db: subscriptionsDb } = createDatabase(subscriptionsDatabaseUrl, subscriptionsAuthToken);

  try {
    const thresholdDate = new Date(Date.now() - delayMinutes * 60 * 1000);

    for (const post of data.posts) {
      if (!post.publishedAt) continue;

      const publishDate = new Date(post.publishedAt);
      if (Number.isNaN(publishDate.getTime())) continue;

      if (publishDate > thresholdDate) {
        // Not old enough yet
        continue;
      }

      const existing = await subscriptionsDb.select({ articleId: sentArticleNotificationsTable.articleId })
        .from(sentArticleNotificationsTable)
        .where(eq(sentArticleNotificationsTable.articleId, post.id))
        .limit(1);

      if (existing.length > 0) {
        continue;
      }

      const payload: PushNotificationPayload = {
        title: post.title,
        body: post.excerpt || 'Read the latest story on freedom times.',
        url: `/posts/${post.slug}`,
        icon: '/favicon.svg',
        badge: '/favicon.svg',
        tag: `article-${post.id}`,
        ttl: 86400,
        urgency: 'high',
      };

      console.log(`[scheduler] ${jobId}: sending notifications for article ${post.id}`);
      await queueNotifications(jobId, payload, env);
      console.log(`[scheduler] ${jobId}: finished queuing for article ${post.id}`);

      await subscriptionsDb.insert(sentArticleNotificationsTable).values({
        articleId: post.id,
        sentAt: sql`CURRENT_TIMESTAMP`,
      }).run();
    }
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

function parseStoredTarget(rawSubscription: string): StoredNotificationTarget | null {
  try {
    const parsed = JSON.parse(rawSubscription) as Record<string, unknown>;
    const platform = parsed.platform;

    if (platform === 'android' || platform === 'ios') {
      const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
      if (!token) {
        return null;
      }

      return {
        platform,
        token,
      };
    }

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
      platform: 'web',
      endpoint,
      keys: { p256dh, auth },
    };
  } catch {
    return null;
  }
}



async function deliverToStoredTarget(params: {
  target: StoredNotificationTarget;
  payload: PushNotificationPayload;
  webPushConfig: WebPushConfig | null;
  androidPushConfig: AndroidPushConfig | null;
  iosPushConfig: IosPushConfig | null;
  getApplicationServerKeys: () => Promise<ApplicationServerKeys>;
  getGoogleAccessToken: () => Promise<string>;
  getApnsToken: () => Promise<string>;
}): Promise<DeliveryResult> {
  const {
    target,
    payload,
    webPushConfig,
    androidPushConfig,
    iosPushConfig,
    getApplicationServerKeys,
    getGoogleAccessToken,
    getApnsToken,
  } = params;

  switch (target.platform) {
    case 'web':
      return sendWebPushNotification(target, payload, webPushConfig, getApplicationServerKeys);
    case 'android':
      return sendAndroidPushNotification(target, payload, androidPushConfig, getGoogleAccessToken);
    case 'ios':
      return sendIosPushNotification(target, payload, iosPushConfig, getApnsToken);
  }
}

async function sendWebPushNotification(
  target: PushTarget,
  payload: PushNotificationPayload,
  config: WebPushConfig | null,
  getApplicationServerKeys: () => Promise<ApplicationServerKeys>,
): Promise<DeliveryResult> {
  if (!config) {
    return {
      ok: false,
      deactivate: false,
      reason: 'Web push delivery is not configured',
    };
  }

  const request = await generatePushHTTPRequest({
    applicationServerKeys: await getApplicationServerKeys(),
    payload: JSON.stringify(payload),
    target,
    adminContact: config.subject,
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
    return { ok: true, deactivate: false };
  }

  const responseText = await safeReadResponseText(response);
  return {
    ok: false,
    deactivate: response.status === 404 || response.status === 410,
    reason: `Web push responded ${response.status}${responseText ? `: ${responseText}` : ''}`,
  };
}

async function sendAndroidPushNotification(
  target: AndroidPushTarget,
  payload: PushNotificationPayload,
  config: AndroidPushConfig | null,
  getGoogleAccessToken: () => Promise<string>,
): Promise<DeliveryResult> {
  if (!config) {
    return {
      ok: false,
      deactivate: false,
      reason: 'Android push delivery is not configured',
    };
  }

  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await getGoogleAccessToken()}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      message: {
        token: target.token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: {
          url: payload.url,
          icon: payload.icon,
          badge: payload.badge,
          tag: payload.tag,
        },
        android: {
          priority: payload.urgency === 'high' ? 'HIGH' : 'NORMAL',
          notification: {
            channelId: config.channelId,
            clickAction: 'FCM_PLUGIN_ACTIVITY',
            tag: payload.tag,
          },
        },
      },
    }),
  });

  if (response.ok) {
    return { ok: true, deactivate: false };
  }

  const responseText = await safeReadResponseText(response);
  const deactivate = response.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(responseText);
  return {
    ok: false,
    deactivate,
    reason: `FCM responded ${response.status}${responseText ? `: ${responseText}` : ''}`,
  };
}

async function sendIosPushNotification(
  target: IosPushTarget,
  payload: PushNotificationPayload,
  config: IosPushConfig | null,
  getApnsToken: () => Promise<string>,
): Promise<DeliveryResult> {
  if (!config) {
    return {
      ok: false,
      deactivate: false,
      reason: 'iOS push delivery is not configured',
    };
  }

  const response = await fetch(`https://${config.host}/3/device/${target.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${await getApnsToken()}`,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-topic': config.bundleId,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      aps: {
        alert: {
          title: payload.title,
          body: payload.body,
        },
        sound: 'default',
        'thread-id': payload.tag,
      },
      url: payload.url,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
    }),
  });

  if (response.ok) {
    return { ok: true, deactivate: false };
  }

  const responseText = await safeReadResponseText(response);
  const deactivate = response.status === 410
    || /BadDeviceToken|DeviceTokenNotForTopic|Unregistered/i.test(responseText);
  return {
    ok: false,
    deactivate,
    reason: `APNs responded ${response.status}${responseText ? `: ${responseText}` : ''}`,
  };
}

async function createApplicationServerKeys(config: WebPushConfig | null): Promise<ApplicationServerKeys> {
  if (!config) {
    throw new Error('Web push delivery is not configured');
  }

  return ApplicationServerKeys.fromJSON({
    publicKey: config.publicKey,
    privateKey: config.privateKey,
  });
}

async function createGoogleAccessToken(config: AndroidPushConfig | null): Promise<string> {
  if (!config) {
    throw new Error('Android push delivery is not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(normalizePrivateKey(config.privateKey), 'RS256');
  const assertion = await new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(config.clientEmail)
    .setSubject(config.clientEmail)
    .setAudience(FCM_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch(FCM_TOKEN_AUDIENCE, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const responseText = await safeReadResponseText(response);
    throw new Error(`Unable to obtain FCM access token (${response.status}${responseText ? `: ${responseText}` : ''})`);
  }

  const tokenResponse = await response.json() as { access_token?: string };
  if (typeof tokenResponse.access_token !== 'string' || tokenResponse.access_token.trim().length === 0) {
    throw new Error('FCM token response did not include access_token');
  }

  return tokenResponse.access_token.trim();
}

async function createApnsToken(config: IosPushConfig | null): Promise<string> {
  if (!config) {
    throw new Error('iOS push delivery is not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(normalizePrivateKey(config.privateKey), 'ES256');

  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(now)
    .sign(privateKey);
}

function readWebPushConfig(env: Env): WebPushConfig | null {
  const publicKey = env.PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.PUSH_VAPID_SUBJECT?.trim() ?? '';

  return publicKey && privateKey && subject
    ? { publicKey, privateKey, subject }
    : null;
}

function readAndroidPushConfig(env: Env): AndroidPushConfig | null {
  const projectId = env.PUSH_ANDROID_FCM_PROJECT_ID?.trim() ?? '';
  const clientEmail = env.PUSH_ANDROID_FCM_CLIENT_EMAIL?.trim() ?? '';
  const privateKey = env.PUSH_ANDROID_FCM_PRIVATE_KEY?.trim() ?? '';

  return projectId && clientEmail && privateKey
    ? {
        projectId,
        clientEmail,
        privateKey,
        channelId: env.PUSH_ANDROID_FCM_CHANNEL_ID?.trim() || DEFAULT_ANDROID_CHANNEL_ID,
      }
    : null;
}

function readIosPushConfig(env: Env): IosPushConfig | null {
  const teamId = env.PUSH_IOS_APNS_TEAM_ID?.trim() ?? '';
  const keyId = env.PUSH_IOS_APNS_KEY_ID?.trim() ?? '';
  const privateKey = env.PUSH_IOS_APNS_PRIVATE_KEY?.trim() ?? '';
  const bundleId = env.PUSH_IOS_APNS_BUNDLE_ID?.trim() ?? '';

  return teamId && keyId && privateKey && bundleId
    ? {
        teamId,
        keyId,
        privateKey,
        bundleId,
        host: env.PUSH_IOS_APNS_HOST?.trim() || DEFAULT_IOS_APNS_HOST,
      }
    : null;
}

function normalizePrivateKey(value: string): string {
  return value
    .replace(/\\\\n/g, '\n') // handle \\n (double-escaped, from populate-android-fcm-env.ps1 bug)
    .replace(/\\n/g, '\n')   // handle \n (correctly single-escaped)
    .replace(/\r/g, '')      // strip stray carriage returns
    .trim();
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

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return '';
  }
}
