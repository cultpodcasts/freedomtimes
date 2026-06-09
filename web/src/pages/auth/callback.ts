import type { APIRoute } from 'astro';
import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  SESSION_COOKIE,
  exchangeCodeForTokens,
  getAuthFlowCookieName,
  getAuthRedirectUri,
  getCookieDeleteOptionsForHost,
  getCookieDomainForHost,
  getRoleClaimDebug,
  getAuthConfig,
  getHomePath,
  makeState,
  getStateCookieName,
  hasEditorialRole,
  isNativeAuthFlow,
  verifyIdToken,
} from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const requestId = ctx.request.headers.get('cf-ray') ?? crypto.randomUUID();
  const config = getAuthConfig();
  const cookieDomain = getCookieDomainForHost(ctx.url.hostname);
  const deleteOptionsList = getCookieDeleteOptionsForHost(ctx.url.hostname);
  const stateParam = ctx.url.searchParams.get('state');
  const code = ctx.url.searchParams.get('code');
  const expectedState = ctx.cookies.get(getStateCookieName())?.value;
  const usesNativeAuth = isNativeAuthFlow(ctx.cookies.get(getAuthFlowCookieName())?.value);

  console.info('[auth.callback] callback received', {
    requestId,
    hasCode: Boolean(code),
    hasState: Boolean(stateParam),
    hasStateCookie: Boolean(expectedState),
  });

  for (const deleteOptions of deleteOptionsList) {
    ctx.cookies.delete(getStateCookieName(), deleteOptions);
    ctx.cookies.delete(getAuthFlowCookieName(), deleteOptions);
  }

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
    const redirectUri = getAuthRedirectUri(ctx.url.origin, usesNativeAuth);
    const { idToken, accessToken } = await exchangeCodeForTokens({ code, redirectUri, config });
    const payload = await verifyIdToken(idToken, config);

    if (!hasEditorialRole(payload)) {
      console.warn('[auth.callback] user denied: missing required editorial role claim', {
        requestId,
        idToken,
        decodedPayload: payload,
        roleDebug: getRoleClaimDebug(payload),
      });
      for (const deleteOptions of deleteOptionsList) {
        ctx.cookies.delete(SESSION_COOKIE, deleteOptions);
        ctx.cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
        ctx.cookies.delete(CSRF_COOKIE, deleteOptions);
      }
      return ctx.redirect('/?denied=1');
    }

    const csrfToken = makeState();

    // Clear any older host-only/domain-scoped auth cookies before issuing a fresh session.
    for (const deleteOptions of deleteOptionsList) {
      ctx.cookies.delete(SESSION_COOKIE, deleteOptions);
      ctx.cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
      ctx.cookies.delete(CSRF_COOKIE, deleteOptions);
    }


    // Set session cookie (id token)
    ctx.cookies.set(SESSION_COOKIE, idToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });

    // Set access token as HttpOnly cookie for API calls (not JS-readable)
    ctx.cookies.set(ACCESS_TOKEN_COOKIE, accessToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 30,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });

    // CSRF token is JS-readable by design for double-submit protection on mutation requests.
    ctx.cookies.set(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 8,
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });

    console.info('[auth.callback] login successful', { requestId });

    return ctx.redirect(getHomePath());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[auth.callback] login failed during token exchange/verification', {
      requestId,
      message,
    });
    for (const deleteOptions of deleteOptionsList) {
      ctx.cookies.delete(SESSION_COOKIE, deleteOptions);
      ctx.cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
      ctx.cookies.delete(CSRF_COOKIE, deleteOptions);
    }
    return ctx.redirect('/?denied=1');
  }
};
