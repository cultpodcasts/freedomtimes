import type { APIRoute } from 'astro';

import {
  getStoryTip,
  parseStoryTipUpdate,
  updateStoryTip,
} from '../../../../lib/story-tips-admin';
import { authorizeTipsApiRequest } from '../../../../lib/tips-session';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, params, request, url }) => {
  const session = await authorizeTipsApiRequest({ cookies, request, url });
  if (session instanceof Response) {
    return session;
  }

  const id = params.id?.trim();
  if (!id) {
    return json({ error: 'Missing tip id.' }, 400);
  }

  try {
    const tip = await getStoryTip(id);
    if (!tip) {
      return json({ error: 'Tip not found.' }, 404);
    }

    return json({ tip }, 200);
  } catch (error) {
    console.error('[admin/story-tips] get failed', { error, id, requestId: session.requestId });
    return json({ error: 'Unable to load story tip.' }, 500);
  }
};

export const PATCH: APIRoute = async ({ cookies, params, request, url }) => {
  const session = await authorizeTipsApiRequest({ cookies, request, url });
  if (session instanceof Response) {
    return session;
  }

  const id = params.id?.trim();
  if (!id) {
    return json({ error: 'Missing tip id.' }, 400);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Request body must be valid JSON.' }, 400);
  }

  const update = parseStoryTipUpdate(payload);
  if (!update) {
    return json({ error: 'Invalid update payload.' }, 400);
  }

  try {
    const tip = await updateStoryTip(id, {
      ...update,
      reviewedBy: update.status && update.status !== 'new' ? session.displayName : undefined,
    });

    if (!tip) {
      return json({ error: 'Tip not found.' }, 404);
    }

    return json({ tip }, 200);
  } catch (error) {
    console.error('[admin/story-tips] update failed', { error, id, requestId: session.requestId });
    return json({ error: 'Unable to update story tip.' }, 500);
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
