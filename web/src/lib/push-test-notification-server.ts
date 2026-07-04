import { eq } from 'drizzle-orm';

import {
  createApplicationServerKeys,
  deliverToStoredTarget,
  parseStoredTarget,
  readWebPushConfig,
} from '../../../shared/push/deliverPushNotification.mjs';
import { readOptionalEnv } from './auth';
import {
  checkReaderTestPushThrottle,
  recordReaderTestPushThrottle,
} from './push-test-throttle';
import { createSubscriptionsDb, pushSubscriptionsTable } from './subscriptions-db';
import type { WebPushSubscriptionRecord } from './push-subscriptions';

export type ReaderTestPushRequest = {
  subscription: WebPushSubscriptionRecord;
};

export type ReaderTestPushResult =
  | { ok: true; delivery: 'server' }
  | { ok: false; error: string; status: number; retryAfterSeconds?: number };

export function readReaderTestPushRequest(body: unknown): ReaderTestPushRequest | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const record = body as Record<string, unknown>;
  const endpoint = typeof record.endpoint === 'string' ? record.endpoint.trim() : '';
  const keys = record.keys;

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
    subscription: {
      endpoint,
      keys: { p256dh, auth },
    },
  };
}

export async function sendReaderTestPushNotification(
  request: ReaderTestPushRequest,
  siteOrigin: string,
): Promise<ReaderTestPushResult> {
  const webPushConfig = readPushDeliveryConfig();
  if (!webPushConfig) {
    return {
      ok: false,
      error: 'Server test push is not configured on this environment.',
      status: 503,
    };
  }

  const { client, db } = createSubscriptionsDb();

  try {
    const rows = await db
      .select({
        id: pushSubscriptionsTable.id,
        subscriptionJson: pushSubscriptionsTable.subscriptionJson,
        active: pushSubscriptionsTable.active,
      })
      .from(pushSubscriptionsTable)
      .where(eq(pushSubscriptionsTable.endpoint, request.subscription.endpoint))
      .limit(1);

    const row = rows[0];
    if (!row || row.active !== 1) {
      return {
        ok: false,
        error: 'This device is not registered for notifications yet.',
        status: 404,
      };
    }

    const storedTarget = parseStoredTarget(row.subscriptionJson);
    if (!storedTarget || storedTarget.platform !== 'web') {
      return {
        ok: false,
        error: 'Test push is only available for browser web push subscriptions.',
        status: 400,
      };
    }

    if (!subscriptionKeysMatch(storedTarget, request.subscription)) {
      return {
        ok: false,
        error: 'Subscription keys do not match our records for this device.',
        status: 403,
      };
    }

    const throttle = await checkReaderTestPushThrottle(request.subscription.endpoint);
    if (!throttle.allowed) {
      return {
        ok: false,
        error: throttle.error,
        status: 429,
        retryAfterSeconds: throttle.retryAfterSeconds,
      };
    }

    const payload = buildReaderTestPayload(siteOrigin);
    const applicationServerKeys = await createApplicationServerKeys(webPushConfig);
    const result = await deliverToStoredTarget({
      target: storedTarget,
      payload,
      webPushConfig,
      androidPushConfig: null,
      iosPushConfig: null,
      getApplicationServerKeys: async () => applicationServerKeys,
      getGoogleAccessToken: async () => {
        throw new Error('Android push is not supported for reader test notifications.');
      },
      getApnsToken: async () => {
        throw new Error('iOS push is not supported for reader test notifications.');
      },
    });

    const now = new Date().toISOString();

    if (!result.ok) {
      await db
        .update(pushSubscriptionsTable)
        .set({
          lastFailureAt: now,
          lastFailureReason: (result.reason ?? 'Reader test push failed.').slice(0, 1000),
          active: result.deactivate ? 0 : 1,
          updatedAt: now,
        })
        .where(eq(pushSubscriptionsTable.id, row.id))
        .run();

      return {
        ok: false,
        error: result.reason ?? 'Unable to deliver the test notification.',
        status: 502,
      };
    }

    await db
      .update(pushSubscriptionsTable)
      .set({
        lastSuccessAt: now,
        active: 1,
        updatedAt: now,
        lastFailureAt: null,
        lastFailureReason: null,
      })
      .where(eq(pushSubscriptionsTable.id, row.id))
      .run();

    await recordReaderTestPushThrottle(request.subscription.endpoint);

    return { ok: true, delivery: 'server' };
  } finally {
    client.close();
  }
}

function subscriptionKeysMatch(
  stored: { keys: { p256dh: string; auth: string } },
  submitted: WebPushSubscriptionRecord,
): boolean {
  return stored.keys.p256dh === submitted.keys.p256dh
    && stored.keys.auth === submitted.keys.auth;
}

function buildReaderTestPayload(siteOrigin: string) {
  const origin = siteOrigin.trim().replace(/\/$/, '');
  return {
    title: 'Freedom Times test notification',
    body: 'If you can read this, push delivery to this device works. Tap to open the site.',
    url: `${origin}/homepage`,
    icon: `${origin}/favicon.svg`,
    badge: `${origin}/favicon.svg`,
    tag: 'freedomtimes-reader-test',
    ttl: 300,
    urgency: 'high' as const,
  };
}

function readPushDeliveryConfig() {
  const env = {
    PUSH_VAPID_PUBLIC_KEY: readOptionalEnv('PUSH_VAPID_PUBLIC_KEY').trim()
      || readOptionalEnv('PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY').trim()
      || readOptionalEnv('PUSH_SUBSCRIBE_PUBLIC_KEY').trim(),
    PUSH_VAPID_PRIVATE_KEY: readOptionalEnv('PUSH_VAPID_PRIVATE_KEY').trim()
      || readOptionalEnv('PUSH_STAGING_VAPID_PRIVATE_KEY').trim()
      || readOptionalEnv('PUSH_PRODUCTION_VAPID_PRIVATE_KEY').trim(),
    PUSH_VAPID_SUBJECT: readOptionalEnv('PUSH_VAPID_SUBJECT').trim()
      || readOptionalEnv('PUSH_STAGING_VAPID_SUBJECT').trim()
      || readOptionalEnv('PUSH_PRODUCTION_VAPID_SUBJECT').trim(),
  };

  return readWebPushConfig(env);
}
