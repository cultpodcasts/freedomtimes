import type { APIRoute } from 'astro';
import { getAuthConfig, getStateCookieName, makeState, logSecretMeta } from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const requestId = ctx.request.headers.get('cf-ray') ?? crypto.randomUUID();
  // Log secrets at request time for debugging
  await logSecretMeta('AUTH0_DOMAIN');
  await logSecretMeta('AUTH0_CLIENT_ID');
  await logSecretMeta('AUTH0_CLIENT_SECRET');

  const config = await getAuthConfig();
  console.log('[auth.login] config (after getAuthConfig)', JSON.stringify(config));
  const state = makeState();
  const redirectUri = `${ctx.url.origin}/auth/callback`;
  console.log('[auth.login] redirectUri', redirectUri);

  console.info('[auth.login] starting login redirect', {
    requestId,
    origin: ctx.url.origin,
    domain: config.domain,
  });

  ctx.cookies.set(getStateCookieName(), state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  // Plain text response for test
  return new Response('PLAIN-TEXT-LOGIN-HANDLER-REACHED', {
    status: 200,
    headers: { 'x-ft-debug': 'login-handler-executed', 'content-type': 'text/plain' }
  });
};
};
