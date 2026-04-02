import type { APIRoute } from 'astro';
import { getAuthConfig, getStateCookieName, makeState } from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const requestId = ctx.request.headers.get('cf-ray') ?? crypto.randomUUID();
  const config = getAuthConfig();
  const state = makeState();
  const redirectUri = `${ctx.url.origin}/auth/callback`;

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

  const authorizeUrl = new URL(`https://${config.domain}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'openid profile email');
  authorizeUrl.searchParams.set('audience', config.apiAudience);
  authorizeUrl.searchParams.set('connection', 'google-oauth2');
  authorizeUrl.searchParams.set('state', state);

  console.info('[auth.login] redirecting to auth0 authorize endpoint', {
    requestId,
    redirectUri,
  });

  return ctx.redirect(authorizeUrl.toString());
};
