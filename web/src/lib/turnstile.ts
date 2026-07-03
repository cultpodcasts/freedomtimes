import { readOptionalEnv } from './auth';

type TurnstileVerifyResponse = {
  success?: boolean;
  'error-codes'?: string[];
};

export async function verifyTurnstileToken(token: string): Promise<boolean> {
  const secret = readOptionalEnv('TURNSTILE_SECRET_KEY').trim();
  if (!secret) {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is not configured');
    return false;
  }

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);

  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch (error) {
    console.error('[turnstile] verify request failed', { error });
    return false;
  }

  let payload: TurnstileVerifyResponse;
  try {
    payload = (await response.json()) as TurnstileVerifyResponse;
  } catch (error) {
    console.error('[turnstile] verify response was not JSON', { error });
    return false;
  }

  if (!response.ok || !payload.success) {
    console.warn('[turnstile] verification failed', {
      status: response.status,
      errorCodes: payload['error-codes'] ?? [],
    });
    return false;
  }

  return true;
}

export function readTurnstileSiteKey(): string {
  return readOptionalEnv('TURNSTILE_SITE_KEY').trim();
}
