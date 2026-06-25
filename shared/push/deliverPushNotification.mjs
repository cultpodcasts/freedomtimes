/**
 * Shared push delivery (web VAPID, Android FCM, iOS APNs) for scheduler + operator send-test.
 * Keep in sync with scheduler-worker/src/deliverPushNotification.ts types.
 */
import { importPKCS8, SignJWT } from 'jose';
import { ApplicationServerKeys, generatePushHTTPRequest, setWebCrypto } from 'webpush-webcrypto';

// webpush-webcrypto auto-wires self.crypto (browsers / Workers). Node only exposes globalThis.crypto.
if (typeof self === 'undefined' && globalThis.crypto) {
  setWebCrypto(globalThis.crypto);
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_TOKEN_AUDIENCE = 'https://oauth2.googleapis.com/token';
export const DEFAULT_ANDROID_CHANNEL_ID = 'reader-alerts';
export const DEFAULT_IOS_APNS_HOST = 'api.push.apple.com';

/**
 * @param {string} rawSubscription
 * @returns {import('./deliverPushNotification.types.mjs').StoredNotificationTarget | null}
 */
export function parseStoredTarget(rawSubscription) {
  try {
    const parsed = JSON.parse(rawSubscription);
    const platform = parsed.platform;

    if (platform === 'android' || platform === 'ios') {
      const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
      if (!token) return null;
      return { platform, token };
    }

    const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : '';
    const keys = parsed.keys;
    if (!endpoint || !keys || typeof keys !== 'object') return null;

    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
    const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
    if (!p256dh || !auth) return null;

    return { platform: 'web', endpoint, keys: { p256dh, auth } };
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {import('./deliverPushNotification.types.mjs').WebPushConfig | null}
 */
export function readWebPushConfig(env) {
  const publicKey = env.PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  const privateKey = env.PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
  const subject = env.PUSH_VAPID_SUBJECT?.trim() ?? '';
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {import('./deliverPushNotification.types.mjs').AndroidPushConfig | null}
 */
export function readAndroidPushConfig(env) {
  const projectId = env.PUSH_ANDROID_FCM_PROJECT_ID?.trim() ?? '';
  const clientEmail = env.PUSH_ANDROID_FCM_CLIENT_EMAIL?.trim() ?? '';
  const privateKey = env.PUSH_ANDROID_FCM_PRIVATE_KEY?.trim() ?? '';
  return projectId && clientEmail && privateKey
    ? {
        projectId,
        clientEmail,
        privateKey,
        channelId: env.PUSH_ANDROID_FCM_CHANNEL_ID?.trim() || DEFAULT_ANDROID_CHANNEL_ID,
      }
    : null;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {import('./deliverPushNotification.types.mjs').IosPushConfig | null}
 */
export function readIosPushConfig(env) {
  const teamId = env.PUSH_IOS_APNS_TEAM_ID?.trim() ?? '';
  const keyId = env.PUSH_IOS_APNS_KEY_ID?.trim() ?? '';
  const privateKey = env.PUSH_IOS_APNS_PRIVATE_KEY?.trim() ?? '';
  const bundleId = env.PUSH_IOS_APNS_BUNDLE_ID?.trim() ?? '';
  return teamId && keyId && privateKey && bundleId
    ? {
        teamId,
        keyId,
        privateKey,
        bundleId,
        host: env.PUSH_IOS_APNS_HOST?.trim() || DEFAULT_IOS_APNS_HOST,
      }
    : null;
}

/**
 * @param {{
 *   target: import('./deliverPushNotification.types.mjs').StoredNotificationTarget;
 *   payload: import('./deliverPushNotification.types.mjs').PushNotificationPayload;
 *   webPushConfig: import('./deliverPushNotification.types.mjs').WebPushConfig | null;
 *   androidPushConfig: import('./deliverPushNotification.types.mjs').AndroidPushConfig | null;
 *   iosPushConfig: import('./deliverPushNotification.types.mjs').IosPushConfig | null;
 *   getApplicationServerKeys: () => Promise<ApplicationServerKeys>;
 *   getGoogleAccessToken: () => Promise<string>;
 *   getApnsToken: () => Promise<string>;
 * }} params
 * @returns {Promise<import('./deliverPushNotification.types.mjs').DeliveryResult>}
 */
export async function deliverToStoredTarget(params) {
  const {
    target,
    payload,
    webPushConfig,
    androidPushConfig,
    iosPushConfig,
    getApplicationServerKeys,
    getGoogleAccessToken,
    getApnsToken,
  } = params;

  switch (target.platform) {
    case 'web':
      return sendWebPushNotification(target, payload, webPushConfig, getApplicationServerKeys);
    case 'android':
      return sendAndroidPushNotification(target, payload, androidPushConfig, getGoogleAccessToken);
    case 'ios':
      return sendIosPushNotification(target, payload, iosPushConfig, getApnsToken);
  }
}

/**
 * @param {import('./deliverPushNotification.types.mjs').WebPushConfig | null} config
 */
export async function createApplicationServerKeys(config) {
  if (!config) throw new Error('Web push delivery is not configured');
  return ApplicationServerKeys.fromJSON({
    publicKey: config.publicKey,
    privateKey: config.privateKey,
  });
}

/**
 * @param {import('./deliverPushNotification.types.mjs').AndroidPushConfig | null} config
 */
export async function createGoogleAccessToken(config) {
  if (!config) throw new Error('Android push delivery is not configured');

  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(normalizePrivateKey(config.privateKey), 'RS256');
  const assertion = await new SignJWT({ scope: FCM_SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(config.clientEmail)
    .setSubject(config.clientEmail)
    .setAudience(FCM_TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const response = await fetch(FCM_TOKEN_AUDIENCE, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const responseText = await safeReadResponseText(response);
    throw new Error(`Unable to obtain FCM access token (${response.status}${responseText ? `: ${responseText}` : ''})`);
  }

  const tokenResponse = await response.json();
  if (typeof tokenResponse.access_token !== 'string' || tokenResponse.access_token.trim().length === 0) {
    throw new Error('FCM token response did not include access_token');
  }
  return tokenResponse.access_token.trim();
}

/**
 * @param {import('./deliverPushNotification.types.mjs').IosPushConfig | null} config
 */
export async function createApnsToken(config) {
  if (!config) throw new Error('iOS push delivery is not configured');

  const now = Math.floor(Date.now() / 1000);
  const privateKey = await importPKCS8(normalizePrivateKey(config.privateKey), 'ES256');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(now)
    .sign(privateKey);
}

async function sendWebPushNotification(target, payload, config, getApplicationServerKeys) {
  if (!config) {
    return { ok: false, deactivate: false, reason: 'Web push delivery is not configured' };
  }

  const request = await generatePushHTTPRequest({
    applicationServerKeys: await getApplicationServerKeys(),
    payload: JSON.stringify(payload),
    target,
    adminContact: config.subject,
    ttl: payload.ttl,
    urgency: payload.urgency,
    topic: toWebPushTopic(payload.tag),
  });

  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
  });

  if (response.ok) return { ok: true, deactivate: false };

  const responseText = await safeReadResponseText(response);
  return {
    ok: false,
    deactivate: response.status === 404 || response.status === 410,
    reason: `Web push responded ${response.status}${responseText ? `: ${responseText}` : ''}`,
  };
}

async function sendAndroidPushNotification(target, payload, config, getGoogleAccessToken) {
  if (!config) {
    return { ok: false, deactivate: false, reason: 'Android push delivery is not configured' };
  }

  const absoluteUrl = absolutePushUrl(payload);

  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await getGoogleAccessToken()}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      message: {
        token: target.token,
        notification: {
          title: payload.title,
          body: payload.body,
          ...(payload.image ? { image: payload.image } : {}),
        },
        data: toFcmDataStrings({
          url: absoluteUrl,
          link: absoluteUrl,
          icon: payload.icon,
          badge: payload.badge,
          tag: payload.tag,
          ...(payload.image ? { image: payload.image } : {}),
        }),
        android: {
          priority: payload.urgency === 'high' ? 'HIGH' : 'NORMAL',
          notification: {
            channelId: config.channelId,
            // Omit clickAction so Capacitor routes taps through MainActivity → pushNotificationActionPerformed.
            tag: payload.tag,
            icon: 'ic_notification',
            color: '#234D69',
            ...(payload.image ? { image: payload.image } : {}),
          },
        },
      },
    }),
  });

  if (response.ok) return { ok: true, deactivate: false };

  const responseText = await safeReadResponseText(response);
  const deactivate = response.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(responseText);
  return {
    ok: false,
    deactivate,
    reason: `FCM responded ${response.status}${responseText ? `: ${responseText}` : ''}`,
  };
}

async function sendIosPushNotification(target, payload, config, getApnsToken) {
  if (!config) {
    return { ok: false, deactivate: false, reason: 'iOS push delivery is not configured' };
  }

  const absoluteUrl = absolutePushUrl(payload);

  const response = await fetch(`https://${config.host}/3/device/${target.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${await getApnsToken()}`,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-topic': config.bundleId,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: 'default',
        'thread-id': payload.tag,
      },
      url: absoluteUrl,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      ...(payload.image ? { image: payload.image } : {}),
    }),
  });

  if (response.ok) return { ok: true, deactivate: false };

  const responseText = await safeReadResponseText(response);
  const deactivate = response.status === 410
    || /BadDeviceToken|DeviceTokenNotForTopic|Unregistered/i.test(responseText);
  return {
    ok: false,
    deactivate,
    reason: `APNs responded ${response.status}${responseText ? `: ${responseText}` : ''}`,
  };
}

/** FCM data payloads require string values; Capacitor reads `link` for Android deep links. */
function toFcmDataStrings(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)]),
  );
}

function normalizePrivateKey(value) {
  return value
    .replace(/\\\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r/g, '')
    .trim();
}

/** Resolve in-app paths to absolute HTTPS URLs for native tap handlers (icon/badge carry site origin). */
function absolutePushUrl(payload) {
  const raw = payload.url?.trim() ?? '';
  if (!raw || /^https?:\/\//i.test(raw)) {
    return raw;
  }

  const origin = deriveSiteOriginFromPayload(payload);
  if (!origin) {
    return raw;
  }

  return `${origin}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function deriveSiteOriginFromPayload(payload) {
  const icon = payload.icon?.trim() ?? '';
  const match = icon.match(/^(https?:\/\/[^/]+)/i);
  return match ? match[1] : '';
}

function toWebPushTopic(tag) {
  const TOPIC_MAX_LENGTH = 32;
  const normalized = tag.trim();
  if (!normalized) return 'default';
  const articleUuidTopic = toArticleUuidTopic(normalized);
  if (articleUuidTopic) return articleUuidTopic;
  if (normalized.length <= TOPIC_MAX_LENGTH) return normalized;
  const suffix = fnv1aHex(normalized).slice(0, 8);
  const prefixMaxLength = TOPIC_MAX_LENGTH - suffix.length - 1;
  return `${normalized.slice(0, prefixMaxLength)}-${suffix}`;
}

function toArticleUuidTopic(tag) {
  const match = /^article-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(tag);
  if (!match) return null;
  return match[1].replace(/-/g, '').toLowerCase();
}

function fnv1aHex(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function safeReadResponseText(response) {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return '';
  }
}
