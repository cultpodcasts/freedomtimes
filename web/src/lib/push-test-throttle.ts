import { env as cfEnv } from 'cloudflare:workers';

export const READER_TEST_PUSH_THROTTLE_BINDING = 'READER_TEST_PUSH_THROTTLE';

const FIVE_MINUTE_TTL_SECONDS = 300;
const TWENTY_FOUR_HOUR_TTL_SECONDS = 86_400;
const FIVE_MINUTE_MAX = 2;
const TWENTY_FOUR_HOUR_MAX = 3;

type ThrottleEntry = {
  count: number;
  expiresAt: number;
};

export type ReaderTestPushThrottleResult =
  | { allowed: true }
  | { allowed: false; error: string; retryAfterSeconds: number };

export async function hashPushEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function checkReaderTestPushThrottle(
  endpoint: string,
): Promise<ReaderTestPushThrottleResult> {
  const kv = readThrottleKv();
  if (!kv) {
    return { allowed: true };
  }

  const hash = await hashPushEndpoint(endpoint);
  const shortWindow = await readThrottleEntry(kv, `test:5m:${hash}`);
  if (shortWindow && shortWindow.count >= FIVE_MINUTE_MAX) {
    return {
      allowed: false,
      error: 'Too many test notifications in the last 5 minutes. Please wait before trying again.',
      retryAfterSeconds: secondsUntilExpiry(shortWindow.expiresAt),
    };
  }

  const dailyWindow = await readThrottleEntry(kv, `test:24h:${hash}`);
  if (dailyWindow && dailyWindow.count >= TWENTY_FOUR_HOUR_MAX) {
    return {
      allowed: false,
      error: 'Daily test notification limit reached (3 per 24 hours). Try again later.',
      retryAfterSeconds: secondsUntilExpiry(dailyWindow.expiresAt),
    };
  }

  return { allowed: true };
}

export async function recordReaderTestPushThrottle(endpoint: string): Promise<void> {
  const kv = readThrottleKv();
  if (!kv) {
    return;
  }

  const hash = await hashPushEndpoint(endpoint);
  await incrementThrottleEntry(kv, `test:5m:${hash}`, FIVE_MINUTE_TTL_SECONDS);
  await incrementThrottleEntry(kv, `test:24h:${hash}`, TWENTY_FOUR_HOUR_TTL_SECONDS);
}

function readThrottleKv(): KVNamespace | null {
  const runtime = cfEnv as Record<string, unknown>;
  const candidate = runtime[READER_TEST_PUSH_THROTTLE_BINDING];
  if (candidate && typeof candidate === 'object' && 'get' in candidate) {
    return candidate as KVNamespace;
  }

  return null;
}

async function readThrottleEntry(kv: KVNamespace, key: string): Promise<ThrottleEntry | null> {
  const raw = await kv.get(key);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThrottleEntry>;
    if (typeof parsed.count !== 'number' || typeof parsed.expiresAt !== 'number') {
      return null;
    }

    if (Date.now() >= parsed.expiresAt) {
      return null;
    }

    return {
      count: parsed.count,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

async function incrementThrottleEntry(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
): Promise<void> {
  const existing = await readThrottleEntry(kv, key);
  if (!existing) {
    await kv.put(
      key,
      JSON.stringify({
        count: 1,
        expiresAt: Date.now() + ttlSeconds * 1000,
      } satisfies ThrottleEntry),
      { expirationTtl: ttlSeconds },
    );
    return;
  }

  await kv.put(
    key,
    JSON.stringify({
      count: existing.count + 1,
      expiresAt: existing.expiresAt,
    } satisfies ThrottleEntry),
  );
}

function secondsUntilExpiry(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}
