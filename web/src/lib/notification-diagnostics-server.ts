import { createSubscriptionsDb, notificationDiagnosticsTable } from './subscriptions-db';

/** In-memory result of the reader's last "Send test notification" attempt (page session). */
export type LastTestNotification = {
  attemptedAt: string;
  sendStatus: 'success' | 'error' | 'pending';
  sendMessage: string;
  delivery: string | null;
  httpStatus: number | null;
  /** true when SW/page confirmed display; false only with evidence; null when unknown. */
  receivedOnDevice: boolean | null;
  receivedAt: string | null;
};

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
  /** Last test-notification attempt in this page session, or null if not attempted. */
  lastTestNotification: LastTestNotification | null;
};

const MAX_USER_NOTE_LENGTH = 500;
const MAX_SUPPORT_MESSAGE_LENGTH = 500;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_BUTTON_LABEL_LENGTH = 80;
const MAX_BUTTON_DISABLED_REASON_LENGTH = 200;
const MAX_TEST_SEND_MESSAGE_LENGTH = 500;
const MAX_TEST_DELIVERY_LENGTH = 40;
const MAX_ISO_TIMESTAMP_LENGTH = 40;

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

  const now = new Date().toISOString();
  await db.insert(notificationDiagnosticsTable).values({
    id,
    payloadJson: JSON.stringify(submission.snapshot),
    userNote: submission.userNote,
    createdAt: now,
    status: 'unread',
    updatedAt: now,
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
  const lastTestNotification = readLastTestNotification(record.lastTestNotification);
  if (lastTestNotification === undefined) {
    return null;
  }

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
    lastTestNotification,
  };
}

/** null = not attempted; undefined = invalid payload (reject snapshot). */
function readLastTestNotification(value: unknown): LastTestNotification | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const attemptedAt = readIsoTimestamp(record.attemptedAt);
  const sendStatus = readEnumString(record.sendStatus, ['success', 'error', 'pending']);
  const sendMessage = readRequiredTrimmedString(record.sendMessage, MAX_TEST_SEND_MESSAGE_LENGTH);
  const delivery = readOptionalTrimmedString(record.delivery, MAX_TEST_DELIVERY_LENGTH);
  const httpStatus = readOptionalHttpStatus(record.httpStatus);
  const receivedOnDevice = readOptionalBooleanOrNull(record.receivedOnDevice);
  const receivedAt = readOptionalIsoTimestamp(record.receivedAt);

  if (
    !attemptedAt
    || !sendStatus
    || !sendMessage
    || httpStatus === undefined
    || receivedOnDevice === undefined
    || receivedAt === undefined
  ) {
    return undefined;
  }

  return {
    attemptedAt,
    sendStatus: sendStatus as LastTestNotification['sendStatus'],
    sendMessage,
    delivery,
    httpStatus,
    receivedOnDevice,
    receivedAt,
  };
}

function readIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ISO_TIMESTAMP_LENGTH) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return trimmed;
}

function readOptionalIsoTimestamp(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const timestamp = readIsoTimestamp(value);
  return timestamp ?? undefined;
}

function readOptionalHttpStatus(value: unknown): number | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599) {
    return undefined;
  }

  return value;
}

/** true/false/null accepted; anything else is invalid. */
function readOptionalBooleanOrNull(value: unknown): boolean | null | undefined {
  if (value === null) {
    return null;
  }

  if (value === true || value === false) {
    return value;
  }

  return undefined;
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
