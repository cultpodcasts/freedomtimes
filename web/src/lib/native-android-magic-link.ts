/**
 * Capacitor Android magic-link deep links.
 *
 * EmDash `@emdash-cms/auth` `sendMagicLink` builds a fixed HTTPS verify URL from
 * `config.baseUrl` with no URL-builder hook (see packages/auth magic-link/index.ts).
 * Freedom Times rewrites that href in the outbound email when the *send* request
 * came from the Capacitor Android shell to an HTTPS **lander** that does not
 * consume the token on GET (Safe Links / scanners can prefetch safely). The
 * lander then bridges to the custom scheme or HTTPS verify on a human click.
 *
 * Email (Capacitor Android):
 *   https://{origin}/auth/native-magic-link?token=…&ft_origin=…
 * App open (custom scheme, after lander / Open app):
 *   news.freedomtimes.app://auth/magic-link/verify?token=…
 * → app loads https://{origin}/_emdash/api/auth/magic-link/verify?token=…
 */

export const NATIVE_APP_SCHEME = 'news.freedomtimes.app';
export const NATIVE_ANDROID_COOKIE = 'ft_native_android';
export const NATIVE_APP_COOKIE = 'ft_native_app';
export const NATIVE_APP_PACKAGE = 'news.freedomtimes.app';

export const MAGIC_LINK_VERIFY_PATH = '/_emdash/api/auth/magic-link/verify';
/** HTTPS lander in email — does not call EmDash verify until the user continues. */
export const MAGIC_LINK_LANDER_PATH = '/auth/native-magic-link';
/** Deep-link path under host `auth` (alongside Auth0 `/callback`). */
export const MAGIC_LINK_DEEP_LINK_PATH = '/magic-link/verify';

export type EmailMessageLike = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
};

function cookieValue(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match?.[1];
}

/**
 * Prefer the Capacitor-set `ft_native_android=1` cookie (not bare Android UA —
 * Chrome on Android must keep HTTPS links). Fallbacks: `ft_native_app=1` plus
 * Android WebView signals (`X-Requested-With` package or Android UA).
 */
export function isCapacitorAndroidMagicLinkRequest(request: Request): boolean {
  const cookieHeader = request.headers.get('cookie') ?? '';
  if (cookieValue(cookieHeader, NATIVE_ANDROID_COOKIE) === '1') {
    return true;
  }

  const nativeApp = cookieValue(cookieHeader, NATIVE_APP_COOKIE) === '1';
  if (!nativeApp) {
    return false;
  }

  const xRequestedWith = (request.headers.get('x-requested-with') ?? '').trim();
  if (xRequestedWith === NATIVE_APP_PACKAGE) {
    return true;
  }

  const ua = request.headers.get('user-agent') ?? '';
  return /Android/i.test(ua);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAllowedMagicLinkOrigin(hostname: string): boolean {
  return hostname === 'freedomtimes.news' || hostname === 'staging.freedomtimes.news';
}

/**
 * Parse an EmDash HTTPS verify URL; returns null when shape/host/token are wrong.
 */
export function parseMagicLinkHttpsVerifyUrl(httpsVerifyUrl: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(httpsVerifyUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.pathname !== MAGIC_LINK_VERIFY_PATH) {
    return null;
  }

  if (!isAllowedMagicLinkOrigin(parsed.hostname)) {
    return null;
  }

  if (!parsed.searchParams.get('token')) {
    return null;
  }

  return parsed;
}

/**
 * HTTPS lander URL for email (clickable in Outlook/Gmail; GET does not verify).
 */
export function toAndroidMagicLinkLanderUrl(httpsVerifyUrl: string): string | null {
  const parsed = parseMagicLinkHttpsVerifyUrl(httpsVerifyUrl);
  if (!parsed) {
    return null;
  }

  const lander = new URL(MAGIC_LINK_LANDER_PATH, parsed.origin);
  lander.searchParams.set('token', parsed.searchParams.get('token')!);
  lander.searchParams.set('ft_origin', parsed.origin);
  const redirect = parsed.searchParams.get('redirect');
  if (redirect) {
    lander.searchParams.set('redirect', redirect);
  }
  return lander.toString();
}

/**
 * Build the custom-scheme URL used by the lander “Open app” button / auto-bridge.
 * Preserves `token` (and any other query params such as `redirect`).
 */
export function toAndroidMagicLinkDeepLink(httpsVerifyUrl: string): string | null {
  const parsed = parseMagicLinkHttpsVerifyUrl(httpsVerifyUrl);
  if (!parsed) {
    return null;
  }

  const deep = new URL(`${NATIVE_APP_SCHEME}://auth${MAGIC_LINK_DEEP_LINK_PATH}`);
  deep.search = parsed.search;
  // Carry the issuing origin so cold-start can verify on the correct host
  // (prod app vs staging build) without relying on the WebView’s current URL.
  deep.searchParams.set('ft_origin', parsed.origin);
  return deep.toString();
}

/**
 * Map a custom-scheme deep link back to the HTTPS EmDash verify URL.
 */
export function resolveAndroidMagicLinkHttpsUrl(
  appUrl: string,
  fallbackOrigin: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== `${NATIVE_APP_SCHEME}:`) {
    return null;
  }

  if (parsed.host !== 'auth' || parsed.pathname !== MAGIC_LINK_DEEP_LINK_PATH) {
    return null;
  }

  const token = parsed.searchParams.get('token');
  if (!token) {
    return null;
  }

  const originParam = parsed.searchParams.get('ft_origin');
  let origin = fallbackOrigin;
  if (originParam) {
    try {
      const originUrl = new URL(originParam);
      if (originUrl.protocol === 'https:' && isAllowedMagicLinkOrigin(originUrl.hostname)) {
        origin = originUrl.origin;
      }
    } catch {
      // keep fallbackOrigin
    }
  }

  const https = new URL(MAGIC_LINK_VERIFY_PATH, origin);
  https.searchParams.set('token', token);
  const redirect = parsed.searchParams.get('redirect');
  if (redirect) {
    https.searchParams.set('redirect', redirect);
  }
  return https.toString();
}

/**
 * When App Links open the HTTPS lander inside Capacitor, jump straight to verify
 * (already in-app — no need for the custom-scheme hop).
 */
export function resolveMagicLinkLanderToHttpsVerify(
  appUrl: string,
  fallbackOrigin: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(appUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || !isAllowedMagicLinkOrigin(parsed.hostname)) {
    return null;
  }

  if (parsed.pathname !== MAGIC_LINK_LANDER_PATH) {
    return null;
  }

  const token = parsed.searchParams.get('token');
  if (!token) {
    return null;
  }

  const originParam = parsed.searchParams.get('ft_origin');
  let origin = parsed.origin || fallbackOrigin;
  if (originParam) {
    try {
      const originUrl = new URL(originParam);
      if (originUrl.protocol === 'https:' && isAllowedMagicLinkOrigin(originUrl.hostname)) {
        origin = originUrl.origin;
      }
    } catch {
      // keep lander origin / fallback
    }
  }

  const https = new URL(MAGIC_LINK_VERIFY_PATH, origin);
  https.searchParams.set('token', token);
  const redirect = parsed.searchParams.get('redirect');
  if (redirect) {
    https.searchParams.set('redirect', redirect);
  }
  return https.toString();
}

/**
 * Build lander deep-link + verify URLs from query params (lander page).
 */
export function buildMagicLinkLanderTargets(params: {
  token: string;
  ftOrigin?: string | null;
  redirect?: string | null;
  pageOrigin: string;
}): { deepLink: string; httpsVerify: string; origin: string } | null {
  const token = params.token.trim();
  if (!token) {
    return null;
  }

  let origin = params.pageOrigin;
  if (params.ftOrigin) {
    try {
      const originUrl = new URL(params.ftOrigin);
      if (originUrl.protocol === 'https:' && isAllowedMagicLinkOrigin(originUrl.hostname)) {
        origin = originUrl.origin;
      }
    } catch {
      // keep pageOrigin
    }
  }

  if (!isAllowedMagicLinkOrigin(new URL(origin).hostname)) {
    return null;
  }

  const https = new URL(MAGIC_LINK_VERIFY_PATH, origin);
  https.searchParams.set('token', token);
  if (params.redirect) {
    https.searchParams.set('redirect', params.redirect);
  }

  const deepLink = toAndroidMagicLinkDeepLink(https.toString());
  if (!deepLink) {
    return null;
  }

  return { deepLink, httpsVerify: https.toString(), origin };
}

/**
 * Rewrite HTTPS magic-link verify URLs in email text/html to the Android
 * HTTPS lander. No-op when the request is not Capacitor Android.
 */
export function wrapMagicLinkEmailForAndroidRequest<T extends EmailMessageLike>(
  message: T,
  request: Request,
): T {
  if (!isCapacitorAndroidMagicLinkRequest(request)) {
    return message;
  }

  const rewriteBody = (body: string | undefined): string | undefined => {
    if (!body) {
      return body;
    }

    // Match absolute HTTPS verify URLs EmDash embeds (any allowed site origin).
    const pattern = new RegExp(
      `https:\\/\\/(?:freedomtimes\\.news|staging\\.freedomtimes\\.news)${escapeRegExp(MAGIC_LINK_VERIFY_PATH)}(\\?[^\\s"'<>]*)?`,
      'gi',
    );

    return body.replace(pattern, (match) => toAndroidMagicLinkLanderUrl(match) ?? match);
  };

  return {
    ...message,
    text: rewriteBody(message.text),
    html: rewriteBody(message.html),
  };
}
