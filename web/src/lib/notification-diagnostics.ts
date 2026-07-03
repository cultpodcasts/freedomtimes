import type { NotificationDiagnosticSnapshot } from './notification-diagnostics-server';
import { getNotificationSupportState } from './device-notifications';

export type { NotificationDiagnosticSnapshot };

export async function collectNotificationDiagnostics(
  publicKey: string,
  options: {
    lastErrorMessage?: string | null;
    supportMessage?: string;
  } = {},
): Promise<NotificationDiagnosticSnapshot> {
  const browser = parseBrowserInfo();
  const os = parseOsInfo();
  const platformType = detectPlatformType();
  const notificationPermission = readNotificationPermission();
  const serviceWorkerSupported = 'serviceWorker' in navigator;
  const serviceWorker = serviceWorkerSupported
    ? await navigator.serviceWorker.getRegistration('/')
    : null;
  const serviceWorkerState = readServiceWorkerState(serviceWorker);
  const pushManagerSupported = 'PushManager' in window;
  const pushSubscription = serviceWorkerSupported && serviceWorker?.pushManager
    ? await serviceWorker.pushManager.getSubscription()
    : null;
  // Single source of truth for enable-button availability and disable reason.
  const supportState = await getNotificationSupportState(publicKey);

  return {
    browserFamily: browser.family,
    browserVersionMajor: browser.versionMajor,
    osFamily: os.family,
    platformType,
    notificationPermission,
    serviceWorkerSupported,
    serviceWorkerRegistered: Boolean(serviceWorker),
    serviceWorkerState,
    pushManagerSupported,
    hasPushSubscription: Boolean(pushSubscription),
    pushEndpointHost: readPushEndpointHost(pushSubscription),
    isStandalonePwa: detectStandalonePwa(),
    vapidConfigured: publicKey.trim().length > 0,
    buttonDisabled: supportState.buttonDisabled,
    buttonLabel: supportState.buttonLabel.slice(0, 80),
    buttonDisabledReason: supportState.buttonDisabledReason?.slice(0, 200) ?? null,
    supportMessage: ((options.supportMessage ?? supportState.message) || 'No status message shown.').slice(0, 500),
    lastErrorMessage: options.lastErrorMessage?.trim().slice(0, 500) ?? null,
    pagePath: `${window.location.pathname}`,
  };
}

function readNotificationPermission(): NotificationDiagnosticSnapshot['notificationPermission'] {
  if (!('Notification' in window)) {
    return 'unsupported';
  }

  if (Notification.permission === 'default' || Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission;
  }

  return 'unsupported';
}

function readServiceWorkerState(
  registration: ServiceWorkerRegistration | null | undefined,
): NotificationDiagnosticSnapshot['serviceWorkerState'] {
  if (!registration) {
    return 'none';
  }

  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) {
    return 'unknown';
  }

  switch (worker.state) {
    case 'installing':
    case 'waiting':
    case 'active':
    case 'redundant':
      return worker.state;
    default:
      return 'unknown';
  }
}

function readPushEndpointHost(subscription: PushSubscription | null): string | null {
  if (!subscription?.endpoint) {
    return null;
  }

  try {
    return new URL(subscription.endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function detectStandalonePwa(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }

  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function detectPlatformType(): NotificationDiagnosticSnapshot['platformType'] {
  if (typeof navigator === 'undefined') {
    return 'unknown';
  }

  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua)) {
    return 'tablet';
  }

  if (/Mobi|Android/i.test(ua)) {
    return 'mobile';
  }

  return 'desktop';
}

function parseBrowserInfo(): { family: NotificationDiagnosticSnapshot['browserFamily']; versionMajor: number | null } {
  const uaData = (navigator as Navigator & {
    userAgentData?: {
      brands?: Array<{ brand: string; version: string }>;
    };
  }).userAgentData;

  if (uaData?.brands?.length) {
    const primary = uaData.brands.find((brand) => !/not\s*a\s*brand/i.test(brand.brand)) ?? uaData.brands[0];
    const family = normalizeBrowserFamily(primary.brand);
    const versionMajor = parseMajorVersion(primary.version);
    return { family, versionMajor };
  }

  const userAgent = navigator.userAgent;
  if (/\bEdg\//.test(userAgent)) {
    return { family: 'edge', versionMajor: parseMajorVersionFromUa(userAgent, /\bEdg\/(\d+)/) };
  }
  if (/\bFirefox\//.test(userAgent)) {
    return { family: 'firefox', versionMajor: parseMajorVersionFromUa(userAgent, /\bFirefox\/(\d+)/) };
  }
  if (/\bSafari\//.test(userAgent) && !/\b(Chromium|Chrome|Edg)\//.test(userAgent)) {
    return { family: 'safari', versionMajor: parseMajorVersionFromUa(userAgent, /\bVersion\/(\d+)/) };
  }
  if (/\bChrome\//.test(userAgent)) {
    return { family: 'chrome', versionMajor: parseMajorVersionFromUa(userAgent, /\bChrome\/(\d+)/) };
  }

  return { family: 'other', versionMajor: null };
}

function parseOsInfo(): { family: NotificationDiagnosticSnapshot['osFamily'] } {
  const ua = navigator.userAgent;
  const platform = navigator.platform?.toLowerCase() ?? '';

  if (/android/i.test(ua)) {
    return { family: 'android' };
  }
  if (/iphone|ipad|ipod/i.test(ua)) {
    return { family: 'ios' };
  }
  if (/win/i.test(platform) || /windows/i.test(ua)) {
    return { family: 'windows' };
  }
  if (/mac/i.test(platform) || /macintosh/i.test(ua)) {
    return { family: 'macos' };
  }
  if (/linux/i.test(platform) || /linux/i.test(ua)) {
    return { family: 'linux' };
  }

  return { family: 'other' };
}

function normalizeBrowserFamily(value: string): NotificationDiagnosticSnapshot['browserFamily'] {
  const lower = value.toLowerCase();
  if (lower.includes('edge')) return 'edge';
  if (lower.includes('firefox')) return 'firefox';
  if (lower.includes('safari')) return 'safari';
  if (lower.includes('chrome') || lower.includes('chromium')) return 'chrome';
  return 'other';
}

function parseMajorVersion(value: string): number | null {
  const match = value.match(/^(\d+)/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMajorVersionFromUa(userAgent: string, pattern: RegExp): number | null {
  const match = userAgent.match(pattern);
  if (!match?.[1]) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export const NOTIFICATION_DIAGNOSTIC_FIELD_LABELS: Record<keyof NotificationDiagnosticSnapshot, string> = {
  browserFamily: 'Browser family',
  browserVersionMajor: 'Browser major version',
  osFamily: 'Operating system',
  platformType: 'Device type',
  notificationPermission: 'Notification permission',
  serviceWorkerSupported: 'Service workers supported',
  serviceWorkerRegistered: 'Service worker registered',
  serviceWorkerState: 'Service worker state',
  pushManagerSupported: 'Push API supported',
  hasPushSubscription: 'Browser push subscription present',
  pushEndpointHost: 'Push service hostname (if subscribed)',
  isStandalonePwa: 'Installed as app / PWA',
  vapidConfigured: 'Site VAPID key configured',
  buttonDisabled: 'Enable button currently disabled',
  buttonLabel: 'Enable button label',
  buttonDisabledReason: 'Why enable is unavailable',
  supportMessage: 'Status message shown to you',
  lastErrorMessage: 'Last error message shown to you',
  pagePath: 'Page path where you saw this',
};

export const NOTIFICATION_DIAGNOSTIC_PRIVACY_NOTES = [
  'We do not collect your IP address, email, account details, or raw browser fingerprint.',
  'We do not store your full push subscription URL or cryptographic keys.',
  'If you are subscribed, we only record the push service hostname (for example fcm.googleapis.com).',
  'Reports are stored for troubleshooting only and reviewed by the editorial team.',
];
