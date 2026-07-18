/**
 * Capacitor Android magic-link deep links.
 *
 * EmDash `@emdash-cms/auth` `sendMagicLink` builds a fixed HTTPS verify URL from
 * `config.baseUrl` with no URL-builder hook (see packages/auth magic-link/index.ts).
 * Freedom Times rewrites that href in the outbound email when the *send* request
 * came from the Capacitor Android shell, so Outlook Safe Links / Firefox do not
 * consume the single-use token before the app opens.
 *
 * Scheme reuses Auth0’s custom protocol:
 *   news.freedomtimes.app://auth/magic-link/verify?token=…
 * → app loads https://{origin}/_emdash/api/auth/magic-link/verify?token=…
 */

export const NATIVE_APP_SCHEME = 'news.freedomtimes.app';
export const NATIVE_ANDROID_COOKIE = 'ft_native_android';
export const NATIVE_APP_COOKIE = 'ft_native_app';
export const NATIVE_APP_PACKAGE = 'news.freedomtimes.app';

export const MAGIC_LINK_VERIFY_PATH = '/_emdash/api/auth/magic-link/verify';
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

/**
 * Build the custom-scheme URL EmDash would have sent as HTTPS.
 * Preserves `token` (and any other query params such as `redirect`).
 */
export function toAndroidMagicLinkDeepLink(httpsVerifyUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(httpsVerifyUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.pathname !== MAGIC_LINK_VERIFY_PATH) {
    return null;
  }

  if (!parsed.searchParams.get('token')) {
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
      if (
        originUrl.protocol === 'https:'
        && (originUrl.hostname === 'freedomtimes.news'
          || originUrl.hostname === 'staging.freedomtimes.news')
      ) {
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
 * Rewrite HTTPS magic-link verify URLs in email text/html to the Android
 * custom scheme. No-op when the request is not Capacitor Android.
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

    return body.replace(pattern, (match) => toAndroidMagicLinkDeepLink(match) ?? match);
  };

  return {
    ...message,
    text: rewriteBody(message.text),
    html: rewriteBody(message.html),
  };
}
