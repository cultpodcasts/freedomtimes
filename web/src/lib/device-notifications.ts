import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

const NATIVE_CHANNEL_ID = 'reader-alerts';
const NATIVE_CHANNEL_NAME = 'Reader Alerts';
const NATIVE_CHANNEL_DESCRIPTION = 'Breaking and important Freedom Times notifications';
const REGISTRATION_TIMEOUT_MS = 30000;

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

  return {
    supported: true,
    buttonDisabled: false,
    message: 'Enable browser notifications on this device to receive published Freedom Times alerts.',
  };
}

export async function enableNotificationsForCurrentDevice(publicKey: string): Promise<string> {
  if (isNativeNotificationPlatform()) {
    await enableNativePushNotifications();
    return 'Notifications enabled for this app.';
  }

  await enableBrowserPushNotifications(publicKey);
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

async function enableBrowserPushNotifications(publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications were blocked in the browser.'
      : 'Notification permission was dismissed.');
  }

  const registration = await navigator.serviceWorker.ready;
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription = existingSubscription ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(publicKey),
  });

  await persistSubscription(subscription.toJSON());
}

async function persistSubscription(payload: unknown): Promise<void> {
  const response = await fetch('/api/push-subscriptions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Subscription save failed with status ${response.status}`);
  }
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