import type { APIRoute } from 'astro';

import {
  readPushSubscriptionRequest,
  upsertPushSubscription,
} from '../../lib/push-subscriptions';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const userAgent = readOptionalHeader(request, 'user-agent');
  const locale = readOptionalHeader(request, 'accept-language');
  const forwardedHost = readOptionalHeader(request, 'x-forwarded-host');
  const forwardedProto = readOptionalHeader(request, 'x-forwarded-proto');
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    console.warn('[push-subscriptions] invalid JSON body', {
      userAgent,
      locale,
      forwardedHost,
      forwardedProto,
    });
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const subscription = readPushSubscriptionRequest(payload);
  if (!subscription) {
    console.warn('[push-subscriptions] invalid subscription payload', {
      userAgent,
      locale,
      forwardedHost,
      forwardedProto,
    });
    return json({ error: 'Invalid push subscription payload.' }, 400);
  }

  try {
    await upsertPushSubscription({
      subscription,
      locale,
      userAgent,
    });
  } catch (error) {
    console.error('[push-subscriptions] failed to persist subscription', {
      error,
      userAgent,
      locale,
      forwardedHost,
      forwardedProto,
      kind: describeSubscription(subscription),
    });
    return json({ error: 'Unable to save push subscription.' }, 500);
  }

  console.info('[push-subscriptions] persisted subscription', {
    userAgent,
    locale,
    forwardedHost,
    forwardedProto,
    kind: describeSubscription(subscription),
  });
  return json({ ok: true }, 201);
};

function readOptionalHeader(request: Request, headerName: string): string | null {
  const value = request.headers.get(headerName)?.trim() ?? '';
  return value.length > 0 ? value : null;
}

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function describeSubscription(subscription: { platform?: string; endpoint?: string }): string {
  if (subscription.platform === 'android' || subscription.platform === 'ios') {
    return subscription.platform;
  }
  if (typeof subscription.endpoint === 'string' && subscription.endpoint.length > 0) {
    return 'web';
  }
  return 'unknown';
}