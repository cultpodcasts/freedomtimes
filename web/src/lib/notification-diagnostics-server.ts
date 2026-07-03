import { createSubscriptionsDb, notificationDiagnosticsTable } from './subscriptions-db';

/** Fields collected client-side for anonymous notification troubleshooting. */
export type NotificationDiagnosticSnapshot = {
  browserFamily: string;
  browserVersionMajor: number | null;
  osFamily: string;
  platformType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  notificationPermission: 'default' | 'granted' | 'denied' | 'unsupported';
  serviceWorkerSupported: boolean;
  serviceWorkerRegistered: boolean;
  serviceWorkerState: 'none' | 'installing' | 'waiting' | 'active' | 'redundant' | 'unknown';
  pushManagerSupported: boolean;
  hasPushSubscription: boolean;
  /** Push endpoint hostname only — never the full URL or subscription keys. */
  pushEndpointHost: string | null;
  isStandalonePwa: boolean;
  vapidConfigured: boolean;
  buttonDisabled: boolean;
  /** Primary enable-control label shown to the reader (e.g. "Enable notifications"). */
  buttonLabel: string;
  /** Why the enable control is disabled/unavailable, or null when ready. */
  buttonDisabledReason: string | null;
  supportMessage: string;
  lastErrorMessage: string | null;
  /** Path only — no query string or hash. */
  pagePath: string;
};

const MAX_USER_NOTE_LENGTH = 500;
const MAX_SUPPORT_MESSAGE_LENGTH = 500;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_BUTTON_LABEL_LENGTH = 80;
const MAX_BUTTON_DISABLED_REASON_LENGTH = 200;

export type NotificationDiagnosticSubmission = {
  snapshot: NotificationDiagnosticSnapshot;
  userNote: string | null;
  turnstileToken: string;
};

export function readNotificationDiagnosticRequest(payload: unknown): NotificationDiagnosticSubmission | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const turnstileToken = readTrimmedString(record.turnstileToken);
  const snapshot = readDiagnosticSnapshot(record.snapshot);
  const userNote = readOptionalTrimmedString(record.userNote, MAX_USER_NOTE_LENGTH);

  if (!turnstileToken || !snapshot) {
    return null;
  }

  return {
    snapshot,
    userNote,
    turnstileToken,
  };
}

export async function persistNotificationDiagnostic(
  submission: NotificationDiagnosticSubmission,
): Promise<string> {
  const id = crypto.randomUUID();
  const { db } = createSubscriptionsDb();

  await db.insert(notificationDiagnosticsTable).values({
    id,
    payloadJson: JSON.stringify(submission.snapshot),
    userNote: submission.userNote,
    createdAt: new Date().toISOString(),
  });

  return id;
}

function readDiagnosticSnapshot(value: unknown): NotificationDiagnosticSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const browserFamily = readEnumString(record.browserFamily, ['chrome', 'edge', 'firefox', 'safari', 'other']);
  const osFamily = readEnumString(record.osFamily, ['windows', 'macos', 'ios', 'android', 'linux', 'other']);
  const platformType = readEnumString(record.platformType, ['desktop', 'mobile', 'tablet', 'unknown']);
  const notificationPermission = readEnumString(
    record.notificationPermission,
    ['default', 'granted', 'denied', 'unsupported'],
  );
  const serviceWorkerState = readEnumString(
    record.serviceWorkerState,
    ['none', 'installing', 'waiting', 'active', 'redundant', 'unknown'],
  );
  const supportMessage = readOptionalTrimmedString(record.supportMessage, MAX_SUPPORT_MESSAGE_LENGTH);
  const lastErrorMessage = readOptionalTrimmedString(record.lastErrorMessage, MAX_ERROR_MESSAGE_LENGTH);
  const buttonLabel = readRequiredTrimmedString(record.buttonLabel, MAX_BUTTON_LABEL_LENGTH);
  const buttonDisabledReason = readOptionalTrimmedString(
    record.buttonDisabledReason,
    MAX_BUTTON_DISABLED_REASON_LENGTH,
  );
  const pagePath = readPagePath(record.pagePath);

  if (
    !browserFamily
    || !osFamily
    || !platformType
    || !notificationPermission
    || !serviceWorkerState
    || supportMessage === null
    || !buttonLabel
    || !pagePath
  ) {
    return null;
  }

  const browserVersionMajor = readOptionalVersionMajor(record.browserVersionMajor);
  const pushEndpointHost = readOptionalHostname(record.pushEndpointHost);

  return {
    browserFamily,
    browserVersionMajor,
    osFamily,
    platformType,
    notificationPermission,
    serviceWorkerSupported: record.serviceWorkerSupported === true,
    serviceWorkerRegistered: record.serviceWorkerRegistered === true,
    serviceWorkerState,
    pushManagerSupported: record.pushManagerSupported === true,
    hasPushSubscription: record.hasPushSubscription === true,
    pushEndpointHost,
    isStandalonePwa: record.isStandalonePwa === true,
    vapidConfigured: record.vapidConfigured === true,
    buttonDisabled: record.buttonDisabled === true,
    buttonLabel,
    buttonDisabledReason,
    supportMessage,
    lastErrorMessage,
    pagePath,
  };
}

function readEnumString(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return allowed.includes(trimmed) ? trimmed : null;
}

function readOptionalVersionMajor(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 999) {
    return null;
  }

  return value;
}

function readOptionalHostname(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 253 || trimmed.includes('/')) {
    return null;
  }

  return trimmed;
}

function readPagePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.length > 200 || trimmed.includes('?') || trimmed.includes('#')) {
    return null;
  }

  return trimmed;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRequiredTrimmedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

function readOptionalTrimmedString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}
