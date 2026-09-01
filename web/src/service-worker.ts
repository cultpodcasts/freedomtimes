/// <reference lib="webworker" />

import { SITE_DISPLAY_NAME } from './lib/site-brand';

const workerScope = self as ServiceWorkerGlobalScope;

const CACHE_NAME = 'freedomtimes-shell-v2'; // pragma: allowlist secret
const SHELL_ASSETS = ['/favicon.ico', '/favicon.svg', '/manifest.webmanifest'];
const ASSET_FETCH_TIMEOUT_MS = 4_000;

type PushNotificationPayload = {
  title?: string;
  body?: string;
  url?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  /** Absolute URL; large image in supporting browsers (e.g. Chrome). */
  image?: string;
};

workerScope.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => workerScope.clients.claim()),
  );
});

function isDocumentNavigation(request: Request): boolean {
  return request.mode === 'navigate' || request.destination === 'document';
}

async function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

workerScope.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await Promise.race([
          cache.addAll(SHELL_ASSETS),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('shell precache timeout')), ASSET_FETCH_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // Precache is best-effort so a slow origin cannot block skipWaiting.
      }
      await workerScope.skipWaiting();
    })(),
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

  // Let the browser talk to the origin for documents. Unbounded fetch() here
  // freezes the tab when SSR is slow or the isolate is wedged.
  if (isDocumentNavigation(request)) {
    return;
  }

  if (!SHELL_ASSETS.includes(requestUrl.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetchWithTimeout(request, ASSET_FETCH_TIMEOUT_MS)),
  );
});

const READER_TEST_NOTIFICATION_TAGS = new Set([
  'freedomtimes-reader-test',
  'freedomtimes-reader-test-local',
]);

/** Must match `TEST_NOTIFICATION_DISPLAYED_MESSAGE` in device-notifications.ts. */
const TEST_NOTIFICATION_DISPLAYED_MESSAGE = 'freedomtimes-test-notification-displayed';

workerScope.addEventListener('push', (event) => {
  const payload = readPushPayload(event.data);

  const options: NotificationOptions = {
    body: payload.body,
    icon: payload.icon,
    badge: payload.badge,
    tag: payload.tag,
    data: {
      url: payload.url,
    },
  };
  if (payload.image) {
    options.image = payload.image;
  }

  event.waitUntil(
    workerScope.registration
      .showNotification(payload.title, options)
      .then(() => notifyClientsOfTestNotificationDisplayed(payload.tag)),
  );
});

workerScope.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = typeof event.notification.data?.url === 'string' && event.notification.data.url.length > 0
    ? event.notification.data.url
    : '/homepage';

  event.waitUntil(focusOrOpenClient(targetUrl));
});

function readPushPayload(data: PushMessageData | null): ReturnType<typeof defaultPushPayload> {
  if (!data) {
    return defaultPushPayload({});
  }

  try {
    return defaultPushPayload(data.json() as PushNotificationPayload);
  } catch {
    return defaultPushPayload({ body: data.text() });
  }
}

function defaultPushPayload(payload: PushNotificationPayload): Required<Omit<PushNotificationPayload, 'image'>> & {
  image?: string;
} {
  const image = payload.image?.trim();
  const base = {
    title: payload.title?.trim() || SITE_DISPLAY_NAME,
    body: payload.body?.trim() || 'A new update is available.',
    url: payload.url?.trim() || '/homepage',
    icon: payload.icon?.trim() || '/favicon.svg',
    badge: payload.badge?.trim() || '/favicon.svg',
    tag: payload.tag?.trim() || 'freedomtimes-notification',
  };
  return image ? { ...base, image } : base;
}

async function notifyClientsOfTestNotificationDisplayed(tag: string): Promise<void> {
  if (!READER_TEST_NOTIFICATION_TAGS.has(tag)) {
    return;
  }

  const clients = await workerScope.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });
  const message = {
    type: TEST_NOTIFICATION_DISPLAYED_MESSAGE,
    tag,
    displayedAt: new Date().toISOString(),
  };

  for (const client of clients) {
    client.postMessage(message);
  }
}

async function focusOrOpenClient(url: string): Promise<void> {
  const absoluteUrl = new URL(url, workerScope.location.origin).toString();
  const windowClients = await workerScope.clients.matchAll({ type: 'window', includeUncontrolled: true });

  let sameOriginClient: WindowClient | undefined;
  for (const client of windowClients) {
    if (new URL(client.url).origin !== workerScope.location.origin) {
      continue;
    }

    sameOriginClient = client;
    if ('navigate' in client && typeof client.navigate === 'function') {
      await client.focus();
      await client.navigate(absoluteUrl);
      return;
    }
  }

  if (sameOriginClient) {
    await sameOriginClient.focus();
  }

  const opened = await workerScope.clients.openWindow(absoluteUrl);
  if (!opened && !sameOriginClient) {
    console.warn('[service-worker] notificationclick: clients.openWindow returned null', absoluteUrl);
  }
}

export {};