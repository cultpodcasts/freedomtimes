import { Capacitor } from '@capacitor/core';

declare global {
  interface Window {
    __ftPwaInitialized?: boolean;
  }
}

function canRegisterServiceWorker(): boolean {
  if (Capacitor.isNativePlatform()) {
    return false;
  }

  if (!('serviceWorker' in navigator)) {
    return false;
  }

  return window.location.protocol === 'https:' || window.location.hostname === 'localhost';
}

export async function initializePwa(): Promise<void> {
  if (window.__ftPwaInitialized || !canRegisterServiceWorker()) {
    return;
  }

  window.__ftPwaInitialized = true;

  const registerServiceWorker = () => {
    void navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch((error) => {
      console.error('[pwa] service worker registration failed', error);
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerServiceWorker, { once: true });
  } else {
    registerServiceWorker();
  }
}