import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

import { isIosWebKitBrowser, isStandalonePwa } from './browser-platform';
import type { LastTestNotification } from './notification-diagnostics-server';
import { SITE_DISPLAY_NAME } from './site-brand';

export type { LastTestNotification };

/** Service worker → client message when a reader test notification is shown. */
export const TEST_NOTIFICATION_DISPLAYED_MESSAGE = 'freedomtimes-test-notification-displayed';

const READER_TEST_NOTIFICATION_TAGS = new Set([
  'freedomtimes-reader-test',
  'freedomtimes-reader-test-local',
]);

let lastTestNotification: LastTestNotification | null = null;
let testNotificationReceiptListenerInstalled = false;

const NATIVE_CHANNEL_ID = 'reader-alerts';
const NATIVE_CHANNEL_NAME = 'Reader Alerts';
const NATIVE_CHANNEL_DESCRIPTION = `Breaking and important ${SITE_DISPLAY_NAME} notifications`;
const REGISTRATION_TIMEOUT_MS = 30000;
const BROWSER_PUSH_TIMEOUT_MS = 30000;

type BrowserKind = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';

type BrowserNotificationMessages = {
  permissionPrompt: string;
  permissionTimeout: string;
  blocked: string;
  dismissed: string;
};

/** iOS WebKit browsers require a Home Screen PWA before web push works (iOS 16.4+). */
const IOS_HOME_SCREEN_INSTALL_MESSAGES: Record<BrowserKind, string> = {
  safari:
    'In Safari, tap Share, choose "Add to Home Screen," then open the site from that icon and enable notifications there.',
  chrome:
    'In Chrome, tap the Share icon in the address bar, choose "Add to Home Screen," then open the site from that icon and enable notifications there.',
  edge:
    'In Edge, open the menu (⋯), tap Share, choose "Add to Home Screen," then open the site from that icon and enable notifications there.',
  firefox:
    'In Firefox, tap Share in the address bar (or open the menu and tap Share), choose "Add to Home Screen," then open the site from that icon and enable notifications there.',
  other:
    'Use your browser\'s Share or menu option to choose "Add to Home Screen," then open the site from that icon and enable notifications there.',
};

const BROWSER_NOTIFICATION_MESSAGES: Record<BrowserKind, BrowserNotificationMessages> = {
  edge: {
    permissionPrompt:
      'In Microsoft Edge, look for a bell icon at the right end of the address bar (not the lock menu), choose Allow, then click Enable notifications again if needed.',
    permissionTimeout:
      'Edge did not show a notification prompt. Open Settings → Cookies and site permissions → Notifications, add this site under Allow, reload, then try again.',
    blocked:
      'Notifications are blocked in Edge. Open Settings → Cookies and site permissions → Notifications, allow this site, reload, then try again.',
    dismissed:
      'Notification permission was dismissed. Click Enable notifications to try again.',
  },
  chrome: {
    permissionPrompt:
      'Choose Allow in the Chrome prompt near the address bar. If you do not see it, check for a notifications icon at the right end of the address bar.',
    permissionTimeout:
      'Chrome did not show a notification prompt. Open the lock icon → Site settings → Notifications, set this site to Allow, reload, then try again.',
    blocked:
      'Notifications are blocked in Chrome. Open the lock icon → Site settings → Notifications, set this site to Allow, reload, then try again.',
    dismissed:
      'Notification permission was dismissed. Click Enable notifications to try again.',
  },
  firefox: {
    permissionPrompt:
      'Choose Allow in the Firefox prompt that appears from the address bar.',
    permissionTimeout:
      'Firefox did not show a notification prompt. Open the lock icon → Permissions, set Notifications to Allow, reload, then try again.',
    blocked:
      'Notifications are blocked in Firefox. Open the lock icon → Permissions, set Notifications to Allow, reload, then try again.',
    dismissed:
      'Notification permission was dismissed. Click Enable notifications to try again.',
  },
  safari: {
    permissionPrompt:
      'Choose Allow in the Safari prompt when it appears.',
    permissionTimeout:
      'Safari did not show a notification prompt. Open Safari → Settings → Websites → Notifications, allow this site, reload, then try again.',
    blocked:
      'Notifications are blocked in Safari. Open Safari → Settings → Websites → Notifications, allow this site, reload, then try again.',
    dismissed:
      'Notification permission was dismissed. Click Enable notifications to try again.',
  },
  other: {
    permissionPrompt:
      'Choose Allow when your browser asks for notification permission.',
    permissionTimeout:
      'Your browser did not show a notification prompt. Open this site\'s settings from the address bar, set Notifications to Allow, reload, then try again.',
    blocked:
      'Notifications are blocked in this browser. Open site settings from the address bar, set Notifications to Allow, reload, then try again.',
    dismissed:
      'Notification permission was dismissed. Click Enable notifications to try again.',
  },
};

type NativePlatform = 'android' | 'ios';

export type NotificationSupportState = {
  supported: boolean;
  buttonDisabled: boolean;
  /** Human-readable reason the enable control is unavailable, or null when ready. */
  buttonDisabledReason: string | null;
  /** Label for the primary enable control in the current state. */
  buttonLabel: string;
  message: string;
  testNotificationAvailable: boolean;
};

const BUTTON_LABEL_ENABLE = 'Enable notifications';
const BUTTON_LABEL_SUBSCRIBED = 'Subscribed';

const BUTTON_DISABLED_REASON = {
  alreadySubscribed: 'Already subscribed on this device',
  permissionDenied: 'Browser notifications are blocked (permission denied)',
  notificationsUnsupported: 'Notifications API not supported in this browser',
  serviceWorkerUnsupported: 'Service workers not supported',
  pushUnsupported: 'Push messaging not supported',
  vapidMissing: 'Push configuration missing on this site',
  androidPushMissing: 'Android push is not configured in this app build',
  iosRequiresHomeScreen: 'On iPhone and iPad, add this site to your Home Screen first',
} as const;

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
        buttonDisabledReason: BUTTON_DISABLED_REASON.androidPushMissing,
        buttonLabel: BUTTON_LABEL_ENABLE,
        message: 'Android push is not configured in this app build yet.',
        testNotificationAvailable: false,
      };
    }

    const permissions = await PushNotifications.checkPermissions();
    if (permissions.receive === 'granted') {
      return {
        supported: true,
        buttonDisabled: true,
        buttonDisabledReason: BUTTON_DISABLED_REASON.alreadySubscribed,
        buttonLabel: BUTTON_LABEL_SUBSCRIBED,
        message: 'Notifications are already enabled for this app.',
        testNotificationAvailable: true,
      };
    }

    return {
      supported: true,
      buttonDisabled: false,
      buttonDisabledReason: null,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: 'Enable notifications on this device to receive app alerts from published EmDash content.',
      testNotificationAvailable: false,
    };
  }

  if (publicKey.trim().length === 0) {
    return {
      supported: false,
      buttonDisabled: true,
      buttonDisabledReason: BUTTON_DISABLED_REASON.vapidMissing,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: 'Notifications are waiting on the staging VAPID public key.',
      testNotificationAvailable: false,
    };
  }

  if (isIosWebKitBrowser() && !isStandalonePwa()) {
    return {
      supported: false,
      buttonDisabled: true,
      buttonDisabledReason: BUTTON_DISABLED_REASON.iosRequiresHomeScreen,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: getIosHomeScreenRequiredMessage(),
      testNotificationAvailable: false,
    };
  }

  if (!('Notification' in window)) {
    return {
      supported: false,
      buttonDisabled: true,
      buttonDisabledReason: BUTTON_DISABLED_REASON.notificationsUnsupported,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: 'This browser does not support web push notifications.',
      testNotificationAvailable: false,
    };
  }

  if (!('serviceWorker' in navigator)) {
    return {
      supported: false,
      buttonDisabled: true,
      buttonDisabledReason: BUTTON_DISABLED_REASON.serviceWorkerUnsupported,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: 'This browser does not support web push notifications.',
      testNotificationAvailable: false,
    };
  }

  if (!('PushManager' in window)) {
    return {
      supported: false,
      buttonDisabled: true,
      buttonDisabledReason: BUTTON_DISABLED_REASON.pushUnsupported,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: 'This browser does not support web push notifications.',
      testNotificationAvailable: false,
    };
  }

  if (Notification.permission === 'granted') {
    try {
      await navigator.serviceWorker.ready;
    } catch {
      // Ignore — fall through to getRegistration below.
    }

    const registration = await navigator.serviceWorker.getRegistration('/');
    const existingSubscription = registration
      ? await registration.pushManager.getSubscription()
      : null;

    if (existingSubscription) {
      void ensureBrowserPushSubscriptionSynced(publicKey);
      return {
        supported: true,
        buttonDisabled: true,
        buttonDisabledReason: BUTTON_DISABLED_REASON.alreadySubscribed,
        buttonLabel: BUTTON_LABEL_SUBSCRIBED,
        message: 'Notifications are already enabled in this browser.',
        testNotificationAvailable: true,
      };
    }

    return {
      supported: true,
      buttonDisabled: false,
      buttonDisabledReason: null,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: 'Notification permission is on, but this browser is not registered yet. Click Enable to finish setup.',
      testNotificationAvailable: false,
    };
  }

  if (Notification.permission === 'denied') {
    return {
      supported: true,
      buttonDisabled: true,
      buttonDisabledReason: BUTTON_DISABLED_REASON.permissionDenied,
      buttonLabel: BUTTON_LABEL_ENABLE,
      message: getBrowserNotificationsBlockedMessage(),
      testNotificationAvailable: false,
    };
  }

  return {
    supported: true,
    buttonDisabled: false,
    buttonDisabledReason: null,
    buttonLabel: BUTTON_LABEL_ENABLE,
    message: `Enable browser notifications on this device to receive published ${SITE_DISPLAY_NAME} alerts.`,
    testNotificationAvailable: false,
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
    getBrowserPermissionTimeoutMessage(),
  );
}

export function getBrowserPermissionPromptMessage(): string {
  return browserNotificationMessages().permissionPrompt;
}

export function getBrowserPermissionTimeoutMessage(): string {
  return browserNotificationMessages().permissionTimeout;
}

export function getBrowserNotificationsBlockedMessage(): string {
  return browserNotificationMessages().blocked;
}

export function getBrowserPermissionDismissedMessage(): string {
  return browserNotificationMessages().dismissed;
}

export function browserNotificationPermissionError(permission: NotificationPermission): Error | null {
  if (permission === 'granted') {
    return null;
  }

  if (permission === 'denied') {
    return new Error(getBrowserNotificationsBlockedMessage());
  }

  return new Error(getBrowserPermissionDismissedMessage());
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

/** Re-persist an existing PushManager subscription after permission was granted earlier. */
export async function ensureBrowserPushSubscriptionSynced(publicKey: string): Promise<void> {
  if (publicKey.trim().length === 0 || !('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  try {
    const registration = await ensureBrowserServiceWorkerRegistration();
    const subscription = await subscribeBrowserPushWithCurrentVapidKey(registration, publicKey);
    await persistSubscription(subscription.toJSON());
  } catch (error) {
    console.warn('[notifications] subscription sync failed', error);
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
      console.warn('[notifications] native notification tap ignored: no url in payload', event.notification);
      return;
    }

    console.info('[notifications] native notification tap →', targetUrl);
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

async function subscribeBrowserPushWithCurrentVapidKey(
  registration: ServiceWorkerRegistration,
  publicKey: string,
): Promise<PushSubscription> {
  const applicationServerKey = decodeBase64Url(publicKey);
  const existingSubscription = await registration.pushManager.getSubscription();

  if (existingSubscription) {
    try {
      return await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    } catch {
      // Stale subscription (e.g. VAPID key rotation): drop and subscribe again.
      await existingSubscription.unsubscribe();
    }
  }

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });
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
    throw browserNotificationPermissionError(permission)
      ?? new Error(getBrowserPermissionDismissedMessage());
  }

  const registration = await withTimeout(
    ensureBrowserServiceWorkerRegistration(),
    BROWSER_PUSH_TIMEOUT_MS,
    'Timed out waiting for the notification service worker. Reload the page and try again.',
  );

  const subscription = await withTimeout(
    subscribeBrowserPushWithCurrentVapidKey(registration, publicKey),
    BROWSER_PUSH_TIMEOUT_MS,
    'Timed out subscribing this browser for push notifications. Reload the page and try again.',
  );

  await withTimeout(
    persistSubscription(subscription.toJSON()),
    BROWSER_PUSH_TIMEOUT_MS,
    'Timed out saving this device for notifications. Try again in a moment.',
  );
}

function detectBrowserKind(): BrowserKind {
  if (typeof navigator === 'undefined') {
    return 'other';
  }

  const userAgent = navigator.userAgent;

  if (/\bEdg\//.test(userAgent)) {
    return 'edge';
  }

  if (/\bFirefox\//.test(userAgent)) {
    return 'firefox';
  }

  if (/\bSafari\//.test(userAgent) && !/\b(Chromium|Chrome|Edg)\//.test(userAgent)) {
    return 'safari';
  }

  if (/\bChrome\//.test(userAgent)) {
    return 'chrome';
  }

  return 'other';
}

function browserNotificationMessages(): BrowserNotificationMessages {
  return BROWSER_NOTIFICATION_MESSAGES[detectBrowserKind()];
}

function getIosHomeScreenRequiredMessage(): string {
  return (
    `On iPhone and iPad, notifications only work after adding ${SITE_DISPLAY_NAME} to your Home Screen. ` +
    IOS_HOME_SCREEN_INSTALL_MESSAGES[detectBrowserKind()]
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

export async function getBrowserPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return null;
  }

  try {
    await navigator.serviceWorker.ready;
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration?.pushManager) {
      return null;
    }

    return registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export function getLastTestNotification(): LastTestNotification | null {
  return lastTestNotification ? { ...lastTestNotification } : null;
}

/** Listen for service-worker confirmation that a test notification was displayed. */
export function ensureTestNotificationReceiptListener(): void {
  if (
    testNotificationReceiptListenerInstalled
    || typeof navigator === 'undefined'
    || !('serviceWorker' in navigator)
  ) {
    return;
  }

  testNotificationReceiptListenerInstalled = true;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }

    const record = data as Record<string, unknown>;
    if (record.type !== TEST_NOTIFICATION_DISPLAYED_MESSAGE) {
      return;
    }

    const tag = typeof record.tag === 'string' ? record.tag : '';
    if (!READER_TEST_NOTIFICATION_TAGS.has(tag)) {
      return;
    }

    if (!lastTestNotification || lastTestNotification.sendStatus !== 'success') {
      return;
    }

    if (lastTestNotification.receivedOnDevice === true) {
      return;
    }

    const receivedAt =
      typeof record.displayedAt === 'string' && record.displayedAt.trim().length > 0
        ? record.displayedAt.trim()
        : new Date().toISOString();

    lastTestNotification = {
      ...lastTestNotification,
      receivedOnDevice: true,
      receivedAt,
    };
  });
}

function beginTestNotificationAttempt(): void {
  ensureTestNotificationReceiptListener();
  lastTestNotification = {
    attemptedAt: new Date().toISOString(),
    sendStatus: 'pending',
    sendMessage: 'Sending test notification…',
    delivery: null,
    httpStatus: null,
    receivedOnDevice: null,
    receivedAt: null,
  };
}

function recordTestNotificationSuccess(options: {
  sendMessage: string;
  delivery: string | null;
  httpStatus: number | null;
  receivedOnDevice: boolean | null;
  receivedAt: string | null;
}): void {
  if (!lastTestNotification) {
    return;
  }

  lastTestNotification = {
    ...lastTestNotification,
    sendStatus: 'success',
    sendMessage: options.sendMessage.slice(0, 500),
    delivery: options.delivery,
    httpStatus: options.httpStatus,
    receivedOnDevice: options.receivedOnDevice,
    receivedAt: options.receivedAt,
  };
}

function recordTestNotificationError(options: {
  sendMessage: string;
  httpStatus?: number | null;
}): void {
  if (!lastTestNotification) {
    return;
  }

  lastTestNotification = {
    ...lastTestNotification,
    sendStatus: 'error',
    sendMessage: options.sendMessage.slice(0, 500),
    delivery: null,
    httpStatus: options.httpStatus ?? null,
    receivedOnDevice: null,
    receivedAt: null,
  };
}

export async function showLocalTestNotification(): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    throw new Error('Notification permission is not granted on this device.');
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported in this browser.');
  }

  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification('Freedom Times test notification', {
    body: 'If you can read this, this browser can display notifications on this device.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: 'freedomtimes-reader-test-local',
  });
}

export async function sendReaderTestPushNotification(): Promise<string> {
  beginTestNotificationAttempt();

  try {
    const subscription = await getBrowserPushSubscription();
    if (!subscription) {
      const message = 'This browser is not registered for push notifications yet.';
      recordTestNotificationError({ sendMessage: message });
      throw new Error(message);
    }

    const payload = subscription.toJSON();
    const endpoint = typeof payload.endpoint === 'string' ? payload.endpoint : '';
    const keys = payload.keys;

    if (!endpoint || !keys || typeof keys !== 'object') {
      const message = 'Unable to read this browser push subscription.';
      recordTestNotificationError({ sendMessage: message });
      throw new Error(message);
    }

    let response: Response;
    try {
      response = await fetch('/api/push-test-notification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint,
          keys,
        }),
      });
    } catch {
      const message = 'Network error while sending the test notification.';
      recordTestNotificationError({ sendMessage: message, httpStatus: null });
      throw new Error(message);
    }

    const result = await response.json().catch(() => ({}));

    if (response.status === 503) {
      await showLocalTestNotification();
      const message =
        'Server test push is not configured here, so we showed a local test notification in this browser instead.';
      const receivedAt = new Date().toISOString();
      recordTestNotificationSuccess({
        sendMessage: message,
        delivery: 'local',
        httpStatus: 503,
        // Local showNotification resolved — we have evidence the OS accepted display.
        receivedOnDevice: true,
        receivedAt,
      });
      return message;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const base =
        typeof result.error === 'string'
          ? result.error
          : 'Too many test notifications. Please wait before trying again.';
      const message = retryAfter
        ? (() => {
          const minutes = Math.ceil(Number.parseInt(retryAfter, 10) / 60);
          return minutes > 1
            ? `${base} Try again in about ${minutes} minutes.`
            : `${base} Try again in a minute.`;
        })()
        : base;
      recordTestNotificationError({ sendMessage: message, httpStatus: 429 });
      throw new Error(message);
    }

    if (!response.ok) {
      const message = typeof result.error === 'string' ? result.error : 'Test notification failed.';
      recordTestNotificationError({ sendMessage: message, httpStatus: response.status });
      throw new Error(message);
    }

    const delivery = typeof result.delivery === 'string' ? result.delivery.slice(0, 40) : null;
    const message = 'Test notification sent to this device. It should appear shortly.';
    recordTestNotificationSuccess({
      sendMessage: message,
      delivery,
      httpStatus: response.status,
      // Receipt is best-effort via service-worker postMessage when the test push is shown.
      receivedOnDevice: null,
      receivedAt: null,
    });
    return message;
  } catch (error) {
    if (lastTestNotification?.sendStatus === 'pending') {
      const message = error instanceof Error ? error.message : 'Test notification failed.';
      recordTestNotificationError({ sendMessage: message, httpStatus: null });
    }
    throw error;
  }
}