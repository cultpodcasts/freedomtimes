import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';

const APP_SCHEME = 'news.freedomtimes.app';
const APP_CALLBACK_HOST = 'auth';
const APP_CALLBACK_PATH = '/callback';
const NATIVE_APP_COOKIE = 'ft_native_app';
const LOGIN_PATH = '/auth/login';
const NATIVE_LOGIN_PATH = '/auth/login?native=1';

declare global {
  interface Window {
    __ftNativeAuthBridgeInitialized?: boolean;
  }
}

function setNativeAppCookie(): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${NATIVE_APP_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
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

function resolveWebCallbackUrl(appUrl: string): string | null {
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

async function handleAuthCallback(appUrl: string): Promise<void> {
  const callbackUrl = resolveWebCallbackUrl(appUrl);

  if (!callbackUrl) {
    return;
  }

  // Close the system browser (Chrome Custom Tabs) before navigating the WebView.
  await Browser.close().catch(() => undefined);
  window.location.replace(callbackUrl);
}

export async function initializeNativeAuthBridge(): Promise<void> {
  if (!Capacitor.isNativePlatform() || window.__ftNativeAuthBridgeInitialized) {
    return;
  }

  window.__ftNativeAuthBridgeInitialized = true;
  setNativeAppCookie();
  rewriteNativeLoginLinks();
  installNativeLoginInterceptor();

  const launchUrl = await App.getLaunchUrl();
  if (launchUrl?.url) {
    await handleAuthCallback(launchUrl.url);
  }

  await App.addListener('appUrlOpen', ({ url }) => handleAuthCallback(url));
}