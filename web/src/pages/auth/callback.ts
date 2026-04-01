import type { APIRoute } from 'astro';
import {
  SESSION_COOKIE,
  exchangeCodeForIdToken,
  getAuthConfig,
  getStateCookieName,
  hasAdminRole,
  verifyIdToken,
} from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const config = getAuthConfig(ctx);
  const stateParam = ctx.url.searchParams.get('state');
  const code = ctx.url.searchParams.get('code');
  const expectedState = ctx.cookies.get(getStateCookieName())?.value;

  ctx.cookies.delete(getStateCookieName(), { path: '/' });

  if (!code || !stateParam || !expectedState || stateParam !== expectedState) {
    return ctx.redirect('/?denied=1');
  }

  try {
    const redirectUri = `${ctx.url.origin}/auth/callback`;
    const idToken = await exchangeCodeForIdToken({ code, redirectUri, config });
    const payload = await verifyIdToken(idToken, config);

    if (!hasAdminRole(payload)) {
      ctx.cookies.delete(SESSION_COOKIE, { path: '/' });
      return ctx.redirect('/?denied=1');
    }

    ctx.cookies.set(SESSION_COOKIE, idToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
    });

    return ctx.redirect('/signed-in');
  } catch {
    ctx.cookies.delete(SESSION_COOKIE, { path: '/' });
    return ctx.redirect('/?denied=1');
  }
};
