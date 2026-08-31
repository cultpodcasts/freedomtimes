import type { APIRoute } from 'astro';
import {
  getAuthConfig,
  getAuthFlowCookieName,
  getAuthRedirectUri,
  getNativeAppCookieName,
  getReturnToCookieName,
  getStateCookieName,
  isNativeAppContext,
  makeState,
  RETURN_TO_COOKIE_MAX_AGE_SECONDS,
  sanitizeReturnToPath,
} from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const requestId = ctx.request.headers.get('cf-ray') ?? crypto.randomUUID();
  const config = getAuthConfig();
  const state = makeState();
  const useNativeApp =
    ctx.url.searchParams.get('native') === '1' ||
    isNativeAppContext(ctx.cookies.get(getNativeAppCookieName())?.value);
  const redirectUri = getAuthRedirectUri(ctx.url.origin, useNativeApp);
  // Gated pages (see admin-session.ts requireAdminPageSession) redirect here with `?next=`
  // so the callback can send the user back to the page they originally wanted.
  const returnTo = sanitizeReturnToPath(ctx.url.searchParams.get('next'));

  console.info('[auth.login] starting login redirect', {
    requestId,
    origin: ctx.url.origin,
    domain: config.domain,
    returnTo,
  });

  ctx.cookies.set(getStateCookieName(), state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  if (returnTo) {
    ctx.cookies.set(getReturnToCookieName(), returnTo, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: RETURN_TO_COOKIE_MAX_AGE_SECONDS,
    });
  } else {
    ctx.cookies.delete(getReturnToCookieName(), { path: '/' });
  }

  if (useNativeApp) {
    ctx.cookies.set(getAuthFlowCookieName(), 'native', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
  } else {
    ctx.cookies.delete(getAuthFlowCookieName(), {
      path: '/',
    });
  }

  const authorizeUrl = new URL(`https://${config.domain}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  // openid: minimal identity scope; roles/permissions remain on token claims via API audience + Auth0 config.
  // offline_access: required for Auth0 to issue a refresh_token (see callback.ts / editorial-session.ts).
  authorizeUrl.searchParams.set('scope', 'openid offline_access');
  authorizeUrl.searchParams.set('audience', config.apiAudience);
  authorizeUrl.searchParams.set('connection', 'google-oauth2');
  authorizeUrl.searchParams.set('state', state);

  console.info('[auth.login] redirecting to auth0 authorize endpoint', {
    requestId,
    redirectUri,
    useNativeApp,
  });

  // Native app fetches this endpoint with Accept: application/json so the authorize URL can be
  // opened in the system browser (Chrome Custom Tabs) rather than inside the WebView.
  // Google blocks OAuth initiated from WebViews and falls back to device authorization flow.
  if (ctx.request.headers.get('accept')?.includes('application/json')) {
    return new Response(JSON.stringify({ url: authorizeUrl.toString() }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  return ctx.redirect(authorizeUrl.toString());
};
