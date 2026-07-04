import type { APIRoute } from 'astro';

import { authorizeReaderApiRequest } from '../../lib/editorial-session';
import {
  persistStoryTip,
  resolveStoryTipSimulateFromPayload,
  STORY_TIP_PREVIEW_TURNSTILE_ERROR,
  STORY_TIP_UNEXPECTED_ERROR,
  validateStoryTipRequest,
} from '../../lib/story-tips';
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
    return json({ error: STORY_TIP_UNEXPECTED_ERROR }, 400);
  }

  const { simulateMode, cleanPayload } = resolveStoryTipSimulateFromPayload(payload, url);

  if (simulateMode === 'unexpected-error') {
    return json({ error: STORY_TIP_UNEXPECTED_ERROR }, 500);
  }

  if (simulateMode === 'expected-error') {
    const simulated = validateStoryTipRequest(cleanPayload, { skipTurnstile: true });
    if (!simulated.ok) {
      return json({ error: simulated.error }, 400);
    }

    return json({ error: STORY_TIP_PREVIEW_TURNSTILE_ERROR }, 403);
  }

  const validated = validateStoryTipRequest(cleanPayload);
  if (!validated.ok) {
    return json({ error: validated.error }, 400);
  }

  const submission = validated.submission;

  const verified = await verifyTurnstileToken(submission.turnstileToken);
  if (!verified) {
    return json({ error: 'Verification failed. Please complete the check and try again.' }, 403);
  }

  try {
    const id = await persistStoryTip(submission);
    if (submission.anonymous) {
      console.info('[story-tips] anonymous tip stored', { id });
    } else {
      console.info('[story-tips] identified tip stored', { id });
    }
    return json({ ok: true, id }, 201);
  } catch (error) {
    console.error('[story-tips] failed to persist tip', { error, anonymous: submission.anonymous });
    return json({ error: 'Unable to save your tip right now. Please try again later.' }, 500);
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
