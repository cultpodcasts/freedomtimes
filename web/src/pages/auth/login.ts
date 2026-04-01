import type { APIRoute } from 'astro';
import { getAuthConfig, getStateCookieName, makeState } from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const config = getAuthConfig(ctx);
  const state = makeState();
  const redirectUri = `${ctx.url.origin}/auth/callback`;

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
  authorizeUrl.searchParams.set('connection', 'google-oauth2');
  authorizeUrl.searchParams.set('state', state);

  return ctx.redirect(authorizeUrl.toString());
};
