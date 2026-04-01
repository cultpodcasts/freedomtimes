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
  const requestId = ctx.request.headers.get('cf-ray') ?? crypto.randomUUID();
  const config = getAuthConfig();
  const stateParam = ctx.url.searchParams.get('state');
  const code = ctx.url.searchParams.get('code');
  const expectedState = ctx.cookies.get(getStateCookieName())?.value;

  console.info('[auth.callback] callback received', {
    requestId,
    hasCode: Boolean(code),
    hasState: Boolean(stateParam),
    hasStateCookie: Boolean(expectedState),
  });

  ctx.cookies.delete(getStateCookieName(), { path: '/' });

  if (!code || !stateParam || !expectedState || stateParam !== expectedState) {
    console.warn('[auth.callback] invalid callback payload/state mismatch', {
      requestId,
      hasCode: Boolean(code),
      hasState: Boolean(stateParam),
      hasStateCookie: Boolean(expectedState),
      stateMatches: Boolean(stateParam && expectedState && stateParam === expectedState),
    });
    return ctx.redirect('/?denied=1');
  }

  try {
    const redirectUri = `${ctx.url.origin}/auth/callback`;
    const idToken = await exchangeCodeForIdToken({ code, redirectUri, config });
    const payload = await verifyIdToken(idToken, config);

    if (!hasAdminRole(payload)) {
      console.warn('[auth.callback] user denied: missing admin role claim', {
        requestId,
      });
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

    console.info('[auth.callback] login successful', { requestId });

    return ctx.redirect('/signed-in');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[auth.callback] login failed during token exchange/verification', {
      requestId,
      message,
    });
    ctx.cookies.delete(SESSION_COOKIE, { path: '/' });
    return ctx.redirect('/?denied=1');
  }
};
