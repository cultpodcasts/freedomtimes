import type { APIRoute } from 'astro';

import {
  readPushSubscriptionRequest,
  upsertPushSubscription,
} from '../../lib/push-subscriptions';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const subscription = readPushSubscriptionRequest(payload);
  if (!subscription) {
    return json({ error: 'Invalid push subscription payload.' }, 400);
  }

  try {
    await upsertPushSubscription({
      subscription,
      locale: readOptionalHeader(request, 'accept-language'),
      userAgent: readOptionalHeader(request, 'user-agent'),
    });
  } catch (error) {
    console.error('[push-subscriptions] failed to persist subscription', error);
    return json({ error: 'Unable to save push subscription.' }, 500);
  }

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