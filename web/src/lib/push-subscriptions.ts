import { readOptionalEnv } from './auth';
import { createSubscriptionsDb, pushSubscriptionsTable } from './subscriptions-db';

export type WebPushSubscriptionRecord = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type NativePushSubscriptionRecord = {
  platform: 'android' | 'ios';
  token: string;
};

export type PushSubscriptionRecord = WebPushSubscriptionRecord | NativePushSubscriptionRecord;

export type PushSubscriptionInsert = {
  subscription: PushSubscriptionRecord;
  locale: string | null;
  userAgent: string | null;
};

export function getPushSubscribePublicKey(): string {
  return readOptionalEnv('PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY').trim()
    || readOptionalEnv('PUSH_SUBSCRIBE_PUBLIC_KEY').trim();
}

export async function upsertPushSubscription(input: PushSubscriptionInsert): Promise<void> {
  const { client, db } = createSubscriptionsDb();

  try {
    const now = new Date().toISOString();
    const endpoint = getStoredEndpoint(input.subscription);
    const subscriptionJson = JSON.stringify(normalizeStoredSubscription(input.subscription));

    await db.insert(pushSubscriptionsTable).values({
      id: crypto.randomUUID(),
      endpoint,
      subscriptionJson,
      locale: input.locale,
      userAgent: input.userAgent,
      active: 1,
      createdAt: now,
      updatedAt: now,
      lastFailureAt: null,
      lastFailureReason: null,
    }).onConflictDoUpdate({
      target: pushSubscriptionsTable.endpoint,
      set: {
        subscriptionJson,
        locale: input.locale,
        userAgent: input.userAgent,
        active: 1,
        updatedAt: now,
      },
    }).run();
  } finally {
    client.close();
  }
}

export function readPushSubscriptionRequest(body: unknown): PushSubscriptionRecord | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const candidate = body as Record<string, unknown>;
  const nativeSubscription = readNativePushSubscription(candidate);

  if (nativeSubscription) {
    return nativeSubscription;
  }

  const endpoint = typeof candidate.endpoint === 'string' ? candidate.endpoint.trim() : '';
  const keys = candidate.keys;

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
    keys: {
      p256dh,
      auth,
    },
  };
}

function readNativePushSubscription(candidate: Record<string, unknown>): NativePushSubscriptionRecord | null {
  const platform = candidate.platform;
  const token = typeof candidate.token === 'string' ? candidate.token.trim() : '';

  if ((platform === 'android' || platform === 'ios') && token.length > 0) {
    return {
      platform,
      token,
    };
  }

  return null;
}

function normalizeStoredSubscription(subscription: PushSubscriptionRecord): Record<string, unknown> {
  if (isNativePushSubscription(subscription)) {
    return {
      platform: subscription.platform,
      token: subscription.token,
    };
  }

  return {
    platform: 'web',
    endpoint: subscription.endpoint,
    keys: subscription.keys,
  };
}

function getStoredEndpoint(subscription: PushSubscriptionRecord): string {
  return isNativePushSubscription(subscription)
    ? `${subscription.platform}:${subscription.token}`
    : subscription.endpoint;
}

function isNativePushSubscription(subscription: PushSubscriptionRecord): subscription is NativePushSubscriptionRecord {
  return 'platform' in subscription && 'token' in subscription;
}

