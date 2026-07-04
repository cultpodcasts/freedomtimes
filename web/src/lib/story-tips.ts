import { isLockedSiteAccess, readOptionalEnv } from './auth';
import { createTipsDb, storyTipsTable } from './tips-db';
import { verifyTurnstileToken } from './turnstile';

export const MIN_BODY_LENGTH = 20;
export const MAX_BODY_LENGTH = 8000;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;

export type StoryTipSubmission = {
  body: string;
  anonymous: boolean;
  contactName: string | null;
  contactEmail: string | null;
  turnstileToken: string;
};

export type ParsedStoryTipRequest = StoryTipSubmission;

export type StoryTipValidationResult =
  | { ok: true; submission: ParsedStoryTipRequest }
  | { ok: false; error: string };

export const STORY_TIP_UNEXPECTED_ERROR =
  "We couldn't send your tip. Please try again.";

/** Shown with unexpected-error banner styling (500, network, etc.). */
export const STORY_TIP_UNEXPECTED_ERROR_DETAIL =
  'Something went wrong on our side. Your tip was not saved — please wait a moment and try again.';

/** Simulated 403 Turnstile failure for operator expected-error previews (valid form). */
export const STORY_TIP_PREVIEW_TURNSTILE_ERROR =
  'Verification failed. Please complete the check and try again.';

const STAGING_HOSTNAME = 'staging.freedomtimes.news';
const PRODUCTION_HOSTNAMES = new Set(['freedomtimes.news', 'www.freedomtimes.news']);

export type StoryTipSimulateMode = 'expected-error' | 'unexpected-error';

function isProductionSiteAccess(requestUrl?: URL): boolean {
  if (readOptionalEnv('SITE_ACCESS_MODE').trim().toLowerCase() === 'public') {
    return true;
  }

  const hostname = requestUrl?.hostname.trim().toLowerCase();
  return Boolean(hostname && PRODUCTION_HOSTNAMES.has(hostname));
}

function isStagingSiteAccess(requestUrl?: URL): boolean {
  if (isLockedSiteAccess()) {
    return true;
  }

  return requestUrl?.hostname.trim().toLowerCase() === STAGING_HOSTNAME;
}

/** Whether `?simulate=` error previews are allowed (local dev or staging only). */
export function allowStoryTipSimulateMode(requestUrl?: URL): boolean {
  if (isProductionSiteAccess(requestUrl)) {
    return false;
  }

  if (import.meta.env.DEV) {
    return true;
  }

  return isStagingSiteAccess(requestUrl);
}

/** Resolve `?simulate=` for operator previews; silently ignored on production. */
export function resolveStoryTipSimulateMode(
  simulateParam: string | null,
  requestUrl?: URL,
): StoryTipSimulateMode | null {
  if (!allowStoryTipSimulateMode(requestUrl)) {
    return null;
  }

  if (simulateParam === 'expected-error' || simulateParam === 'unexpected-error') {
    return simulateParam;
  }

  return null;
}

/** HTTP statuses where the API returns a deliberate, user-facing message. */
export function isStoryTipExpectedErrorStatus(status: number): boolean {
  return status === 400 || status === 403 || status === 429;
}

export type StoryTipValidateOptions = {
  /** Staging simulate mode — skip Turnstile token requirement. */
  skipTurnstile?: boolean;
};

/** Strip `_simulate` from POST body; ignored on production. */
export function resolveStoryTipSimulateFromPayload(
  payload: unknown,
  requestUrl?: URL,
): { simulateMode: StoryTipSimulateMode | null; cleanPayload: unknown } {
  if (!payload || typeof payload !== 'object') {
    return { simulateMode: null, cleanPayload: payload };
  }

  const record = payload as Record<string, unknown>;
  const { _simulate, ...rest } = record;

  if (!allowStoryTipSimulateMode(requestUrl)) {
    return { simulateMode: null, cleanPayload: rest };
  }

  const simulateMode =
    _simulate === 'expected-error' || _simulate === 'unexpected-error' ? _simulate : null;

  return { simulateMode, cleanPayload: rest };
}

export function validateStoryTipRequest(
  payload: unknown,
  options?: StoryTipValidateOptions,
): StoryTipValidationResult {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: STORY_TIP_UNEXPECTED_ERROR };
  }

  const record = payload as Record<string, unknown>;
  const body = readTrimmedString(record.body);
  const anonymous = record.anonymous !== false;
  const turnstileToken = readTrimmedString(record.turnstileToken);

  if (!body) {
    return { ok: false, error: 'Please enter your tip.' };
  }

  if (body.length < MIN_BODY_LENGTH) {
    return {
      ok: false,
      error: `Please write at least ${MIN_BODY_LENGTH} characters so we have enough detail to follow up.`,
    };
  }

  if (body.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      error: `Your tip is too long. Please keep it under ${MAX_BODY_LENGTH} characters.`,
    };
  }

  if (!options?.skipTurnstile && !turnstileToken) {
    return { ok: false, error: 'Please complete the verification check.' };
  }

  let contactName: string | null = null;
  let contactEmail: string | null = null;

  if (!anonymous) {
    contactName = readTrimmedString(record.contactName);
    contactEmail = readTrimmedString(record.contactEmail)?.toLowerCase() ?? null;

    if (!contactName) {
      return { ok: false, error: 'Please enter your name, or check "Submit anonymously".' };
    }

    if (contactName.length > MAX_NAME_LENGTH) {
      return { ok: false, error: 'Your name is too long. Please shorten it.' };
    }

    if (!contactEmail) {
      return { ok: false, error: 'Please enter your email, or check "Submit anonymously".' };
    }

    if (contactEmail.length > MAX_EMAIL_LENGTH || !isPlausibleEmail(contactEmail)) {
      return { ok: false, error: 'Please enter a valid email address.' };
    }
  }

  return {
    ok: true,
    submission: {
      body,
      anonymous,
      contactName,
      contactEmail,
      turnstileToken: turnstileToken ?? '',
    },
  };
}

/** @deprecated Prefer validateStoryTipRequest for user-facing errors. */
export function readStoryTipRequest(payload: unknown): ParsedStoryTipRequest | null {
  const result = validateStoryTipRequest(payload);
  return result.ok ? result.submission : null;
}

export { verifyTurnstileToken } from './turnstile';

export async function persistStoryTip(submission: StoryTipSubmission): Promise<string> {
  const id = crypto.randomUUID();
  const { db } = createTipsDb();

  await db.insert(storyTipsTable).values({
    id,
    body: submission.body,
    anonymous: submission.anonymous ? 1 : 0,
    contactName: submission.anonymous ? null : submission.contactName,
    contactEmail: submission.anonymous ? null : submission.contactEmail,
    createdAt: new Date().toISOString(),
  });

  return id;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
