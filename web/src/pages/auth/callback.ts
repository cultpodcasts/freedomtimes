import type { APIRoute } from 'astro';
import {
  clearAuthCookies,
  exchangeCodeForTokens,
  getAuthFlowCookieName,
  getAuthRedirectUri,
  getCookieDeleteOptionsForHost,
  getCookieDomainForHost,
  getRoleClaimDebug,
  getAuthConfig,
  getReturnToCookieName,
  makeState,
  getStateCookieName,
  hasStaffLoginRole,
  isNativeAuthFlow,
  resolvePostLoginRedirect,
  sanitizeReturnToPath,
  setAuthCookies,
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
  // Single-use: read now, then wipe below regardless of outcome so a stale value never leaks
  // into an unrelated future login.
  const returnTo = sanitizeReturnToPath(ctx.cookies.get(getReturnToCookieName())?.value);

  console.info('[auth.callback] callback received', {
    requestId,
    hasCode: Boolean(code),
    hasState: Boolean(stateParam),
    hasStateCookie: Boolean(expectedState),
    returnTo,
  });

  for (const deleteOptions of deleteOptionsList) {
    ctx.cookies.delete(getStateCookieName(), deleteOptions);
    ctx.cookies.delete(getAuthFlowCookieName(), deleteOptions);
    ctx.cookies.delete(getReturnToCookieName(), deleteOptions);
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
    const { idToken, accessToken, refreshToken } = await exchangeCodeForTokens({ code, redirectUri, config });
    const payload = await verifyIdToken(idToken, config);

    if (!hasStaffLoginRole(payload)) {
      console.warn('[auth.callback] user denied: missing required staff role claim', {
        requestId,
        idToken,
        decodedPayload: payload,
        roleDebug: getRoleClaimDebug(payload),
      });
      clearAuthCookies(ctx.cookies, deleteOptionsList);
      return ctx.redirect('/?denied=1');
    }

    // Clear any older host-only/domain-scoped auth cookies before issuing a fresh session.
    clearAuthCookies(ctx.cookies, deleteOptionsList);

    setAuthCookies(ctx.cookies, {
      idToken,
      accessToken,
      refreshToken,
      csrfToken: makeState(),
      cookieDomain,
    });

    if (!refreshToken) {
      // Should not happen once login.ts requests offline_access, but silent-refresh simply
      // won't be available for this session if Auth0 ever omits it.
      console.warn('[auth.callback] token exchange did not return a refresh_token', { requestId });
    }

    console.info('[auth.callback] login successful', { requestId, returnTo });

    return ctx.redirect(resolvePostLoginRedirect(returnTo, payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[auth.callback] login failed during token exchange/verification', {
      requestId,
      message,
    });
    clearAuthCookies(ctx.cookies, deleteOptionsList);
    return ctx.redirect('/?denied=1');
  }
};
