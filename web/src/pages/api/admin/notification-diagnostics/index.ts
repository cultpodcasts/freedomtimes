import type { APIRoute } from 'astro';

import { authorizeNotificationDiagnosticsApiRequest } from '../../../../lib/notification-diagnostics-session';
import {
  listNotificationDiagnostics,
  parseNotificationDiagnosticListStatus,
} from '../../../../lib/notification-diagnostics-admin';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  const session = await authorizeNotificationDiagnosticsApiRequest({ cookies, request, url });
  if (session instanceof Response) {
    return session;
  }

  const statusParam = url.searchParams.get('status');
  const status = statusParam
    ? parseNotificationDiagnosticListStatus(statusParam)
    : 'unread';
  if (statusParam && !status) {
    return json({ error: 'Invalid status filter.' }, 400);
  }

  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

  try {
    const reports = await listNotificationDiagnostics({ status: status ?? 'unread', limit });
    return json({ reports }, 200);
  } catch (error) {
    console.error('[admin/notification-diagnostics] list failed', {
      error,
      requestId: session.requestId,
    });
    return json({ error: 'Unable to load notification diagnostic reports.' }, 500);
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
