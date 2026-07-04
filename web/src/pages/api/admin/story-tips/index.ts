import type { APIRoute } from 'astro';

import { listStoryTips, parseStoryTipStatus } from '../../../../lib/story-tips-admin';
import { authorizeTipsApiRequest } from '../../../../lib/tips-session';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  const session = await authorizeTipsApiRequest({ cookies, request, url });
  if (session instanceof Response) {
    return session;
  }

  const statusParam = url.searchParams.get('status');
  const status = statusParam ? parseStoryTipStatus(statusParam) : undefined;
  if (statusParam && !status) {
    return json({ error: 'Invalid status filter.' }, 400);
  }

  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

  try {
    const tips = await listStoryTips({ status, limit });
    return json({ tips }, 200);
  } catch (error) {
    console.error('[admin/story-tips] list failed', { error, requestId: session.requestId });
    return json({ error: 'Unable to load story tips.' }, 500);
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
