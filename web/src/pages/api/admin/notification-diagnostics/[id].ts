import type { APIRoute } from 'astro';

import {
  getNotificationDiagnostic,
  parseNotificationDiagnosticUpdate,
  updateNotificationDiagnostic,
} from '../../../../lib/notification-diagnostics-admin';
import { authorizeNotificationDiagnosticsApiRequest } from '../../../../lib/notification-diagnostics-session';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  const session = await authorizeNotificationDiagnosticsApiRequest({ cookies, request, url });
  if (session instanceof Response) {
    return session;
  }

  const id = params.id?.trim();
  if (!id) {
    return json({ error: 'Missing report id.' }, 400);
  }

  try {
    const report = await getNotificationDiagnostic(id);
    if (!report) {
      return json({ error: 'Report not found.' }, 404);
    }

    return json({ report }, 200);
  } catch (error) {
    console.error('[admin/notification-diagnostics] get failed', {
      error,
      id,
      requestId: session.requestId,
    });
    return json({ error: 'Unable to load notification diagnostic report.' }, 500);
  }
};

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  const session = await authorizeNotificationDiagnosticsApiRequest({ cookies, request, url });
  if (session instanceof Response) {
    return session;
  }

  const id = params.id?.trim();
  if (!id) {
    return json({ error: 'Missing report id.' }, 400);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const update = parseNotificationDiagnosticUpdate(payload);
  if (!update) {
    return json({ error: 'Invalid update payload.' }, 400);
  }

  try {
    const report = await updateNotificationDiagnostic(id, update);
    if (!report) {
      return json({ error: 'Report not found.' }, 404);
    }

    return json({ report }, 200);
  } catch (error) {
    console.error('[admin/notification-diagnostics] update failed', {
      error,
      id,
      requestId: session.requestId,
    });
    return json({ error: 'Unable to update notification diagnostic report.' }, 500);
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
