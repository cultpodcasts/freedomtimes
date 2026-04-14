import { createClient } from '@libsql/client/web';
import { readEnv, readOptionalEnv } from './auth';

export type PushSubscriptionRecord = {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
};

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
  const client = createSubscriptionsClient();

  try {
    const now = new Date().toISOString();
    const subscriptionJson = JSON.stringify(input.subscription);

    await client.execute({
      sql: `
        INSERT INTO push_subscriptions (
          id,
          endpoint,
          subscription_json,
          locale,
          user_agent,
          active,
          updated_at,
          last_failure_at,
          last_failure_reason
        ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL)
        ON CONFLICT(endpoint) DO UPDATE SET
          subscription_json = excluded.subscription_json,
          locale = excluded.locale,
          user_agent = excluded.user_agent,
          active = 1,
          updated_at = excluded.updated_at,
          last_failure_at = NULL,
          last_failure_reason = NULL
      `,
      args: [crypto.randomUUID(), input.subscription.endpoint, subscriptionJson, input.locale, input.userAgent, now],
    });
  } finally {
    client.close();
  }
}

export function readPushSubscriptionRequest(body: unknown): PushSubscriptionRecord | null {
  if (!body || typeof body !== 'object') {
    return null;
  }

  const candidate = body as Record<string, unknown>;
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

function createSubscriptionsClient() {
  return createClient({
    url: readEnv('TURSO_SUBSCRIPTIONS_DATABASE_URL'),
    authToken: readEnv('TURSO_SUBSCRIPTIONS_AUTH_TOKEN'),
  });
}