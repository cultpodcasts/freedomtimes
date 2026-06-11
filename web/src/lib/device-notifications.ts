import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

import { SITE_DISPLAY_NAME } from './site-brand';

const NATIVE_CHANNEL_ID = 'reader-alerts';
const NATIVE_CHANNEL_NAME = 'Reader Alerts';
const NATIVE_CHANNEL_DESCRIPTION = `Breaking and important ${SITE_DISPLAY_NAME} notifications`;
const REGISTRATION_TIMEOUT_MS = 30000;
const BROWSER_PUSH_TIMEOUT_MS = 30000;
const BROWSER_PERMISSION_PROMPT_MESSAGE =
  'In Microsoft Edge, click the bell icon at the right end of the address bar (not the lock menu) and choose Allow. Then click Enable notifications again if needed.';
const BROWSER_PERMISSION_TIMEOUT_MESSAGE =
  'Edge did not show a notification prompt. Open Settings → Cookies and site permissions → Notifications, add this site under Allow, reload, then try again.';
const BROWSER_NOTIFICATIONS_BLOCKED_MESSAGE =
  'Notifications are blocked in this browser. Open site settings (lock or tune icon in the address bar), set Notifications to Allow, then reload this page.';

type NativePlatform = 'android' | 'ios';

type NotificationSupportState = {
  supported: boolean;
  buttonDisabled: boolean;
  message: string;
};

type NativeAppConfigPlugin = {
  getFirebaseStatus: () => Promise<{ firebaseConfigured: boolean }>;
};

type RegistrationWaiter = {
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

declare global {
  interface Window {
    __ftNativePushInitialized?: boolean;
  }
}

const registrationWaiters: RegistrationWaiter[] = [];
let nativeRegistrationPromise: Promise<void> | null = null;
let listenersAttached = false;
let nativeAutoRegistrationPromise: Promise<void> | null = null;
const nativeAppConfig = registerPlugin<NativeAppConfigPlugin>('NativeAppConfig');

export async function getNotificationSupportState(publicKey: string): Promise<NotificationSupportState> {
  if (isNativeNotificationPlatform()) {
    await initializeNativePushBridge();

    if (getNativePlatform() === 'android' && !(await isAndroidFirebaseConfigured())) {
      return {
        supported: false,
        buttonDisabled: true,
        message: 'Android push is not configured in this app build yet.',
      };
    }

    const permissions = await PushNotifications.checkPermissions();
    if (permissions.receive === 'granted') {
      return {
        supported: true,
        buttonDisabled: true,
        message: 'Notifications are already enabled for this app.',
      };
    }

    return {
      supported: true,
      buttonDisabled: false,
      message: 'Enable notifications on this device to receive app alerts from published EmDash content.',
    };
  }

  if (publicKey.trim().length === 0) {
    return {
      supported: false,
      buttonDisabled: true,
      message: 'Notifications are waiting on the staging VAPID public key.',
    };
  }

  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return {
      supported: false,
      buttonDisabled: true,
      message: 'This browser does not support web push notifications.',
    };
  }

  if (Notification.permission === 'granted') {
    return {
      supported: true,
      buttonDisabled: true,
      message: 'Notifications are already enabled in this browser.',
    };
  }

  if (Notification.permission === 'denied') {
    return {
      supported: true,
      buttonDisabled: true,
      message: BROWSER_NOTIFICATIONS_BLOCKED_MESSAGE,
    };
  }

  return {
    supported: true,
    buttonDisabled: false,
    message: `Enable browser notifications on this device to receive published ${SITE_DISPLAY_NAME} alerts.`,
  };
}

export function requestBrowserNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) {
    return Promise.reject(new Error('This browser does not support web push notifications.'));
  }

  if (Notification.permission !== 'default') {
    return Promise.resolve(Notification.permission);
  }

  return withTimeout(
    Notification.requestPermission(),
    BROWSER_PUSH_TIMEOUT_MS,
    BROWSER_PERMISSION_TIMEOUT_MESSAGE,
  );
}

export function getBrowserPermissionPromptMessage(): string {
  return BROWSER_PERMISSION_PROMPT_MESSAGE;
}

export async function prepareBrowserPushInfrastructure(): Promise<void> {
  if (isNativeNotificationPlatform() || !('serviceWorker' in navigator)) {
    return;
  }

  try {
    await ensureBrowserServiceWorkerRegistration();
  } catch (error) {
    console.warn('[notifications] service worker pre-registration failed', error);
  }
}

export async function enableNotificationsForCurrentDevice(
  publicKey: string,
  permission?: NotificationPermission,
): Promise<string> {
  if (isNativeNotificationPlatform()) {
    await enableNativePushNotifications();
    return 'Notifications enabled for this app.';
  }

  await enableBrowserPushNotifications(publicKey, permission);
  return 'Notifications enabled for this browser.';
}

export async function initializeNativePushBridge(): Promise<void> {
  if (!isNativeNotificationPlatform() || window.__ftNativePushInitialized || listenersAttached) {
    return;
  }

  listenersAttached = true;
  window.__ftNativePushInitialized = true;

  await PushNotifications.addListener('registration', ({ value }) => {
    resolveRegistrationWaiters(value);

    const platform = getNativePlatform();
    if (platform) {
      persistSubscription({ platform, token: value }).catch((error) => {
        console.warn('[notifications] native subscription persist failed', error);
      });
    }
  });

  await PushNotifications.addListener('registrationError', (error) => {
    rejectRegistrationWaiters(new Error(error.error));
  });

  await PushNotifications.addListener('pushNotificationReceived', (notification) => {
    console.info('[notifications] native push received', notification);
  });

  await PushNotifications.addListener('pushNotificationActionPerformed', (event) => {
    const targetUrl = readNotificationTargetUrl(event.notification);
    if (!targetUrl) {
      return;
    }

    window.location.assign(targetUrl);
  });

  void ensureNativePushRegistration();
}

function isNativeNotificationPlatform(): boolean {
  return Capacitor.isNativePlatform() && getNativePlatform() !== null;
}

async function enableNativePushNotifications(): Promise<void> {
  if (nativeRegistrationPromise) {
    return nativeRegistrationPromise;
  }

  nativeRegistrationPromise = (async () => {
    const platform = getNativePlatform();
    if (!platform) {
      throw new Error('Native push notifications are not supported on this platform.');
    }

    if (platform === 'android' && !(await isAndroidFirebaseConfigured())) {
      throw new Error('Android push is not configured in this app build yet.');
    }

    await initializeNativePushBridge();

    let permissions = await PushNotifications.checkPermissions();
    if (permissions.receive === 'prompt' || permissions.receive === 'prompt-with-rationale') {
      permissions = await PushNotifications.requestPermissions();
    }

    if (permissions.receive !== 'granted') {
      throw new Error('User denied native notification permissions.');
    }

    if (platform === 'android') {
      await PushNotifications.createChannel({
        id: NATIVE_CHANNEL_ID,
        name: NATIVE_CHANNEL_NAME,
        description: NATIVE_CHANNEL_DESCRIPTION,
        importance: 5,
        visibility: 1,
        vibration: true,
      });
    }

    const tokenPromise = waitForRegistrationToken();
    await PushNotifications.register();
    const token = await tokenPromise;

    // If the registration listener already persisted the token, this is a
    // harmless upsert (same endpoint). We still await it so errors surface.
    await persistSubscription({
      platform,
      token,
    });
  })().finally(() => {
    nativeRegistrationPromise = null;
  });

  return nativeRegistrationPromise;
}

async function ensureNativePushRegistration(): Promise<void> {
  if (nativeAutoRegistrationPromise) {
    return nativeAutoRegistrationPromise;
  }

  nativeAutoRegistrationPromise = (async () => {
    const platform = getNativePlatform();
    if (!platform) {
      return;
    }

    if (platform === 'android' && !(await isAndroidFirebaseConfigured())) {
      return;
    }

    const permissions = await PushNotifications.checkPermissions();
    if (permissions.receive !== 'granted') {
      return;
    }

    if (platform === 'android') {
      await PushNotifications.createChannel({
        id: NATIVE_CHANNEL_ID,
        name: NATIVE_CHANNEL_NAME,
        description: NATIVE_CHANNEL_DESCRIPTION,
        importance: 5,
        visibility: 1,
        vibration: true,
      });
    }

    await PushNotifications.register();
  })().catch((error) => {
    console.warn('[notifications] native auto-registration skipped', error);
  }).finally(() => {
    nativeAutoRegistrationPromise = null;
  });

  return nativeAutoRegistrationPromise;
}

async function ensureBrowserServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported in this browser.');
  }

  const existingRegistration = await navigator.serviceWorker.getRegistration('/');
  if (!existingRegistration?.active) {
    await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
  }

  return navigator.serviceWorker.ready;
}

async function enableBrowserPushNotifications(
  publicKey: string,
  requestedPermission?: NotificationPermission,
): Promise<void> {
  const permission = requestedPermission ?? await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? BROWSER_NOTIFICATIONS_BLOCKED_MESSAGE
      : 'Notification permission was dismissed.');
  }

  const registration = await withTimeout(
    ensureBrowserServiceWorkerRegistration(),
    BROWSER_PUSH_TIMEOUT_MS,
    'Timed out waiting for the notification service worker. Reload the page and try again.',
  );

  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription = existingSubscription ?? await withTimeout(
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(publicKey),
    }),
    BROWSER_PUSH_TIMEOUT_MS,
    'Timed out subscribing this browser for push notifications. Reload the page and try again.',
  );

  await withTimeout(
    persistSubscription(subscription.toJSON()),
    BROWSER_PUSH_TIMEOUT_MS,
    'Timed out saving this device for notifications. Try again in a moment.',
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId = 0;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function persistSubscription(payload: unknown): Promise<void> {
  const summary = summarizeSubscriptionPayload(payload);
  console.info('[notifications] persist subscription start', summary);

  const response = await fetch('/api/push-subscriptions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 300);
    console.warn('[notifications] persist subscription failed', {
      ...summary,
      status: response.status,
      responseText,
    });
    throw new Error(`Subscription save failed with status ${response.status}`);
  }

  console.info('[notifications] persist subscription ok', {
    ...summary,
    status: response.status,
  });
}

function waitForRegistrationToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    let waiter: RegistrationWaiter;

    const timeoutId = window.setTimeout(() => {
      rejectRegistrationWaiter(waiter, new Error('Timed out waiting for native push registration token.'));
    }, REGISTRATION_TIMEOUT_MS);

    waiter = {
      resolve,
      reject,
      timeoutId,
    };

    registrationWaiters.push(waiter);
  });
}

function resolveRegistrationWaiters(token: string): void {
  while (registrationWaiters.length > 0) {
    const waiter = registrationWaiters.shift();
    if (!waiter) {
      continue;
    }

    window.clearTimeout(waiter.timeoutId);
    waiter.resolve(token);
  }
}

function rejectRegistrationWaiters(error: Error): void {
  while (registrationWaiters.length > 0) {
    const waiter = registrationWaiters.shift();
    if (!waiter) {
      continue;
    }

    rejectRegistrationWaiter(waiter, error);
  }
}

function rejectRegistrationWaiter(waiter: RegistrationWaiter, error: Error): void {
  window.clearTimeout(waiter.timeoutId);
  waiter.reject(error);
}

function getNativePlatform(): NativePlatform | null {
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios' ? platform : null;
}

function readNotificationTargetUrl(notification: unknown): string | null {
  if (!notification || typeof notification !== 'object') {
    return null;
  }

  const candidate = notification as Record<string, unknown>;
  const nestedData = candidate.data && typeof candidate.data === 'object'
    ? candidate.data as Record<string, unknown>
    : null;

  const rawUrl = typeof candidate.link === 'string'
    ? candidate.link.trim()
    : typeof candidate.url === 'string'
      ? candidate.url.trim()
      : typeof nestedData?.url === 'string'
        ? nestedData.url.trim()
        : typeof nestedData?.link === 'string'
          ? nestedData.link.trim()
          : '';

  if (rawUrl.length === 0) {
    return new URL('/homepage', window.location.origin).toString();
  }

  return new URL(rawUrl, window.location.origin).toString();
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function isAndroidFirebaseConfigured(): Promise<boolean> {
  try {
    const status = await nativeAppConfig.getFirebaseStatus();
    return status.firebaseConfigured === true;
  } catch {
    return false;
  }
}

function summarizeSubscriptionPayload(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'unknown' };
  }

  const candidate = payload as Record<string, unknown>;
  const platform = typeof candidate.platform === 'string' ? candidate.platform : '';
  const token = typeof candidate.token === 'string' ? candidate.token : '';
  const endpoint = typeof candidate.endpoint === 'string' ? candidate.endpoint : '';

  if ((platform === 'android' || platform === 'ios') && token.length > 0) {
    return {
      kind: platform,
      tokenPrefix: token.slice(0, 16),
    };
  }

  if (endpoint.length > 0) {
    return {
      kind: 'web',
      endpointPrefix: endpoint.slice(0, 48),
    };
  }

  return { kind: 'unknown' };
}