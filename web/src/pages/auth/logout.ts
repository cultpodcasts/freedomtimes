import type { APIRoute } from 'astro';
import { clearAuthCookies, getAuthConfig, getCookieDeleteOptionsForHost } from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const config = getAuthConfig();
  const deleteOptionsList = getCookieDeleteOptionsForHost(ctx.url.hostname);
  const returnTo = `${ctx.url.origin}/`;

  clearAuthCookies(ctx.cookies, deleteOptionsList);

  const logoutUrl = new URL(`https://${config.domain}/v2/logout`);
  logoutUrl.searchParams.set('client_id', config.clientId);
  logoutUrl.searchParams.set('returnTo', returnTo);

  return ctx.redirect(logoutUrl.toString());
};
