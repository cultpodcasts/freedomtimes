import type { APIRoute } from 'astro';

import { authorizeReaderApiRequest } from '../../lib/editorial-session';
import {
  readReaderTestPushRequest,
  sendReaderTestPushNotification,
} from '../../lib/push-test-notification-server';

export const prerender = false;

export const POST: APIRoute = async ({ cookies, request, url }) => {
  const auth = await authorizeReaderApiRequest({ cookies, request, url });
  if (auth instanceof Response) {
    return auth;
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const submission = readReaderTestPushRequest(payload);
  if (!submission) {
    return json({ error: 'Invalid push subscription payload.' }, 400);
  }

  const siteOrigin = `${url.protocol}//${url.host}`;
  const result = await sendReaderTestPushNotification(submission, siteOrigin);

  if (!result.ok) {
    return json({ error: result.error }, result.status, result.retryAfterSeconds);
  }

  return json({ ok: true, delivery: result.delivery }, 200);
};

function json(
  body: Record<string, unknown>,
  status: number,
  retryAfterSeconds?: number,
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };

  if (typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
    headers['retry-after'] = String(retryAfterSeconds);
  }

  return new Response(JSON.stringify(body), { status, headers });
}
