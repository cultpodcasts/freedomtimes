/// <reference lib="webworker" />

import { SITE_DISPLAY_NAME } from './lib/site-brand';

const workerScope = self as ServiceWorkerGlobalScope;

const CACHE_NAME = 'freedomtimes-shell-v1';
const SHELL_ASSETS = ['/', '/favicon.ico', '/favicon.svg', '/manifest.webmanifest'];

type PushNotificationPayload = {
  title?: string;
  body?: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
};

workerScope.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => workerScope.skipWaiting()),
  );
});

workerScope.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => workerScope.clients.claim()),
  );
});

workerScope.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== workerScope.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/')));
    return;
  }

  if (SHELL_ASSETS.includes(requestUrl.pathname)) {
    event.respondWith(caches.match(request).then((response) => response ?? fetch(request)));
  }
});

workerScope.addEventListener('push', (event) => {
  const payload = readPushPayload(event.data);

  event.waitUntil(
    workerScope.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      data: {
        url: payload.url,
      },
    }),
  );
});

workerScope.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = typeof event.notification.data?.url === 'string' && event.notification.data.url.length > 0
    ? event.notification.data.url
    : '/homepage';

  event.waitUntil(focusOrOpenClient(targetUrl));
});

function readPushPayload(data: PushMessageData | null): Required<PushNotificationPayload> {
  if (!data) {
    return defaultPushPayload({});
  }

  try {
    return defaultPushPayload(data.json() as PushNotificationPayload);
  } catch {
    return defaultPushPayload({ body: data.text() });
  }
}

function defaultPushPayload(payload: PushNotificationPayload): Required<PushNotificationPayload> {
  return {
    title: payload.title?.trim() || SITE_DISPLAY_NAME,
    body: payload.body?.trim() || 'A new update is available.',
    url: payload.url?.trim() || '/homepage',
    icon: payload.icon?.trim() || '/favicon.svg',
    badge: payload.badge?.trim() || '/favicon.svg',
    tag: payload.tag?.trim() || 'freedomtimes-notification',
  };
}

async function focusOrOpenClient(url: string): Promise<void> {
  const absoluteUrl = new URL(url, workerScope.location.origin).toString();
  const clients = await workerScope.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of clients) {
    if (client.url === absoluteUrl) {
      await client.focus();
      return;
    }
  }

  await workerScope.clients.openWindow(absoluteUrl);
}

export {};