import type { APIRoute } from 'astro';
import { ACCESS_TOKEN_COOKIE, SESSION_COOKIE, getAuthConfig } from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const config = getAuthConfig();
  const returnTo = `${ctx.url.origin}/`;

  ctx.cookies.delete(SESSION_COOKIE, { path: '/' });
  ctx.cookies.delete(ACCESS_TOKEN_COOKIE, { path: '/' });

  const logoutUrl = new URL(`https://${config.domain}/v2/logout`);
  logoutUrl.searchParams.set('client_id', config.clientId);
  logoutUrl.searchParams.set('returnTo', returnTo);

  return ctx.redirect(logoutUrl.toString());
};
