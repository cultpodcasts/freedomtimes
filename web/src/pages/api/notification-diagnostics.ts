import type { APIRoute } from 'astro';

import { authorizeReaderApiRequest } from '../../lib/editorial-session';
import {
  persistNotificationDiagnostic,
  readNotificationDiagnosticRequest,
} from '../../lib/notification-diagnostics-server';
import { verifyTurnstileToken } from '../../lib/turnstile';

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

  const submission = readNotificationDiagnosticRequest(payload);
  if (!submission) {
    return json({ error: 'Invalid diagnostic payload.' }, 400);
  }

  const verified = await verifyTurnstileToken(submission.turnstileToken);
  if (!verified) {
    return json({ error: 'Human verification failed. Please try again.' }, 403);
  }

  try {
    const id = await persistNotificationDiagnostic(submission);
    console.info('[notification-diagnostics] anonymous report stored', { id });
    return json({ ok: true, id }, 201);
  } catch (error) {
    console.error('[notification-diagnostics] failed to persist report', { error });
    return json({ error: 'Unable to send your report right now. Please try again later.' }, 500);
  }
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
