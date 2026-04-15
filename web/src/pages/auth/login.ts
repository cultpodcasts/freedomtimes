import type { APIRoute } from 'astro';
import {
  getAuthConfig,
  getAuthFlowCookieName,
  getAuthRedirectUri,
  getNativeAppCookieName,
  getStateCookieName,
  isNativeAppContext,
  makeState,
} from '../../lib/auth';

export const GET: APIRoute = async (ctx) => {
  const requestId = ctx.request.headers.get('cf-ray') ?? crypto.randomUUID();
  const config = getAuthConfig();
  const state = makeState();
  const useNativeApp =
    ctx.url.searchParams.get('native') === '1' ||
    isNativeAppContext(ctx.cookies.get(getNativeAppCookieName())?.value);
  const redirectUri = getAuthRedirectUri(ctx.url.origin, useNativeApp);

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
  // Minimal identity scope; roles/permissions remain on token claims via API audience + Auth0 config.
  authorizeUrl.searchParams.set('scope', 'openid');
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
