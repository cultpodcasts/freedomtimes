import type { APIRoute } from 'astro';
import { ACCESS_TOKEN_COOKIE, CSRF_COOKIE, SESSION_COOKIE, getAuthConfig, getCookieDeleteOptionsForHost } from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const config = getAuthConfig();
  const deleteOptionsList = getCookieDeleteOptionsForHost(ctx.url.hostname);
  const returnTo = `${ctx.url.origin}/`;

  for (const deleteOptions of deleteOptionsList) {
    ctx.cookies.delete(SESSION_COOKIE, deleteOptions);
    ctx.cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
    ctx.cookies.delete(CSRF_COOKIE, deleteOptions);
  }

  const logoutUrl = new URL(`https://${config.domain}/v2/logout`);
  logoutUrl.searchParams.set('client_id', config.clientId);
  logoutUrl.searchParams.set('returnTo', returnTo);

  return ctx.redirect(logoutUrl.toString());
};
