import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

const APP_SCHEME = 'news.freedomtimes.app';
const APP_CALLBACK_HOST = 'auth';
const APP_CALLBACK_PATH = '/callback';
const NATIVE_APP_COOKIE = 'ft_native_app';

declare global {
  interface Window {
    __ftNativeAuthBridgeInitialized?: boolean;
  }
}

function setNativeAppCookie(): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${NATIVE_APP_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
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

  window.location.replace(callbackUrl);
}

export async function initializeNativeAuthBridge(): Promise<void> {
  if (!Capacitor.isNativePlatform() || window.__ftNativeAuthBridgeInitialized) {
    return;
  }

  window.__ftNativeAuthBridgeInitialized = true;
  setNativeAppCookie();

  const launchUrl = await App.getLaunchUrl();
  if (launchUrl?.url) {
    await handleAuthCallback(launchUrl.url);
  }

  await App.addListener('appUrlOpen', ({ url }) => handleAuthCallback(url));
}