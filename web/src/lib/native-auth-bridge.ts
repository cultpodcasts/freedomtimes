import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

import {
  NATIVE_ANDROID_COOKIE,
  NATIVE_APP_COOKIE,
  resolveAndroidMagicLinkHttpsUrl,
  resolveMagicLinkLanderToHttpsVerify,
} from './native-android-magic-link';
import { claimCapacitorLaunchUrl } from './native-launch-url';

const APP_SCHEME = 'news.freedomtimes.app';
const APP_CALLBACK_HOST = 'auth';
const APP_CALLBACK_PATH = '/callback';
const LOGIN_PATH = '/auth/login';
const NATIVE_LOGIN_PATH = '/auth/login?native=1';

/** Hosts registered for HTTPS App Links (AndroidManifest + assetlinks.json). */
const APP_LINK_HOSTS = new Set(['freedomtimes.news', 'staging.freedomtimes.news']);

declare global {
  interface Window {
    __ftNativeAuthBridgeInitialized?: boolean;
    /**
     * Called from Android MainActivity when a VIEW intent arrives. Prefer this
     * over a blind WebView.loadUrl so custom-scheme → HTTPS verify still runs.
     * Returns true when the URL was claimed and handled.
     */
    __ftHandleAppUrlOpen?: (url: string) => boolean;
  }
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function setNativeAppCookie(): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  const base = `Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  document.cookie = `${NATIVE_APP_COOKIE}=1; ${base}`;
  // Capacitor Android only — drives custom-scheme magic-link emails (not Chrome UA).
  if (Capacitor.getPlatform() === 'android') {
    document.cookie = `${NATIVE_ANDROID_COOKIE}=1; ${base}`;
  }
}

function isLoginPath(url: URL): boolean {
  return url.origin === window.location.origin && url.pathname === LOGIN_PATH;
}

function rewriteNativeLoginLinks(): void {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(anchor.href, window.location.origin);
    } catch {
      continue;
    }

    if (!isLoginPath(parsedUrl) || parsedUrl.searchParams.get('native') === '1') {
      continue;
    }

    parsedUrl.searchParams.set('native', '1');
    anchor.href = parsedUrl.toString();
  }
}

async function openLoginInSystemBrowser(): Promise<void> {
  try {
    const response = await fetch(NATIVE_LOGIN_PATH, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new Error(`Login URL fetch failed: ${response.status}`);
    }

    const { url } = await response.json() as { url: string };
    await Browser.open({ url });
  } catch {
    // Fallback: navigate the WebView directly (will work but may trigger device flow on some accounts)
    window.location.assign(new URL(NATIVE_LOGIN_PATH, window.location.origin).toString());
  }
}
function installNativeLoginInterceptor(): void {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(anchor.href, window.location.origin);
    } catch {
      return;
    }

    if (!isLoginPath(parsedUrl)) {
      return;
    }

    event.preventDefault();
    openLoginInSystemBrowser();
  });
}

function resolveAuth0WebCallbackUrl(appUrl: string): string | null {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(appUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== `${APP_SCHEME}:`) {
    return null;
  }

  if (parsedUrl.host !== APP_CALLBACK_HOST || parsedUrl.pathname !== APP_CALLBACK_PATH) {
    return null;
  }

  const callbackUrl = new URL('/auth/callback', window.location.origin);
  callbackUrl.search = parsedUrl.search;
  return callbackUrl.toString();
}

/**
 * HTTPS App Link (or paste/open-with) → load that URL in the Capacitor WebView.
 * Critical for EmDash magic links: must hit `/_emdash/api/auth/magic-link/verify?token=…`
 * so the session cookie lands in the WebView jar, not Firefox.
 */
function resolveHttpsAppLinkUrl(appUrl: string): string | null {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(appUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'https:' || !APP_LINK_HOSTS.has(parsedUrl.hostname)) {
    return null;
  }

  return parsedUrl.toString();
}

function alreadyAtUrl(target: string): boolean {
  try {
    const next = new URL(target);
    const current = new URL(window.location.href);
    return (
      current.href === next.href
      || (
        current.origin === next.origin
        && current.pathname === next.pathname
        && current.search === next.search
      )
    );
  } catch {
    return false;
  }
}

async function handleAppOpenUrl(appUrl: string): Promise<void> {
  const auth0Callback = resolveAuth0WebCallbackUrl(appUrl);
  if (auth0Callback) {
    await Browser.close().catch(() => undefined);
    window.location.replace(auth0Callback);
    return;
  }

  // Custom-scheme magic link from lander “Open app” → HTTPS verify in this WebView.
  const magicLinkHttps = resolveAndroidMagicLinkHttpsUrl(appUrl, window.location.origin);
  if (magicLinkHttps) {
    await Browser.close().catch(() => undefined);
    if (!alreadyAtUrl(magicLinkHttps)) {
      window.location.replace(magicLinkHttps);
    }
    return;
  }

  // HTTPS lander opened via App Links → skip the HTML hop; verify in-app now.
  const landerVerify = resolveMagicLinkLanderToHttpsVerify(appUrl, window.location.origin);
  if (landerVerify) {
    await Browser.close().catch(() => undefined);
    if (!alreadyAtUrl(landerVerify)) {
      window.location.replace(landerVerify);
    }
    return;
  }

  const httpsTarget = resolveHttpsAppLinkUrl(appUrl);
  if (!httpsTarget || alreadyAtUrl(httpsTarget)) {
    return;
  }

  // Consume magic-link token / open deep path inside the WebView cookie jar.
  window.location.replace(httpsTarget);
}

function tryHandleAppOpenUrl(url: string): boolean {
  // Claim lander + verify + deep-link aliases together so a successful lander→verify
  // cannot be followed by getLaunchUrl(lander) re-GETting verify (invalid_link).
  if (
    !url
    || !claimCapacitorLaunchUrl(url, sessionStorageOrNull(), {
      fallbackOrigin: window.location.origin,
    })
  ) {
    return false;
  }
  void handleAppOpenUrl(url);
  return true;
}

export async function initializeNativeAuthBridge(): Promise<void> {
  if (!Capacitor.isNativePlatform() || window.__ftNativeAuthBridgeInitialized) {
    return;
  }

  window.__ftNativeAuthBridgeInitialized = true;
  setNativeAppCookie();
  rewriteNativeLoginLinks();
  installNativeLoginInterceptor();

  // Native MainActivity prefers this hook so warm intents are handled even when
  // Capacitor's appUrlOpen listener was torn down with the previous document.
  window.__ftHandleAppUrlOpen = (url: string) => tryHandleAppOpenUrl(url);

  // Cold-start VIEW intent — Capacitor keeps returning the same URI for the
  // process lifetime. Claim once so later FT page loads (e.g. `/admin`) do not
  // re-GET a single-use EmDash magic-link verify URL.
  const launchUrl = await App.getLaunchUrl();
  if (launchUrl?.url) {
    tryHandleAppOpenUrl(launchUrl.url);
  }

  // Warm starts / subsequent App Links. Claim the exact URL string so duplicate
  // deliveries (and MainActivity's __ftHandleAppUrlOpen) are ignored, but a
  // fresh magic-link token always navigates — including from EmDash login.
  await App.addListener('appUrlOpen', ({ url }) => {
    tryHandleAppOpenUrl(url);
  });
}
