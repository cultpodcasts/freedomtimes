/**
 * Send one test push (web VAPID, Android FCM, iOS APNs) — see web/docs/PUSH_NOTIFICATIONS_TEST_PLAN.md.
 *
 * Modes:
 * - Article (--slug | --article <slug> | --article-id): production payload via shared
 *   buildArticlePushPayload + {siteOrigin}/api/recent-published-posts.json (same as scheduler)
 * - Generic (default): custom or default title/body/url; no featured image
 */
import { webcrypto } from 'node:crypto';
import { createClient } from '@libsql/client';
import { buildArticlePushPayload } from '../../shared/push/articleNotificationPayload.mjs';
import {
  createApnsToken,
  createApplicationServerKeys,
  createGoogleAccessToken,
  deliverToStoredTarget,
  parseStoredTarget,
  readAndroidPushConfig,
  readIosPushConfig,
  readWebPushConfig,
  DEFAULT_ANDROID_CHANNEL_ID,
  DEFAULT_IOS_APNS_HOST,
} from '../../shared/push/deliverPushNotification.mjs';
import { loadEnvDev, pickFirstEnv, pickFirstEnvOptional } from './lib/load-env-dev.mjs';
import { subscriptionsBindingsForTarget } from './lib/turso-env-bindings.mjs';
import { setWebCrypto } from 'webpush-webcrypto';

setWebCrypto(webcrypto);

const STAGING_SITE_ORIGIN = 'https://staging.freedomtimes.news';
const PRODUCTION_SITE_ORIGIN = 'https://freedomtimes.news';
const STAGING_IOS_APNS_HOST = 'api.sandbox.push.apple.com';

const PRODUCTION_ANDROID_FCM_PROJECT_ID_KEYS = [
  'PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID',
  'PUSH_ANDROID_FCM_PROJECT_ID',
  'PUSH_STAGING_ANDROID_FCM_PROJECT_ID',
];
const PRODUCTION_ANDROID_FCM_CLIENT_EMAIL_KEYS = [
  'PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL',
  'PUSH_ANDROID_FCM_CLIENT_EMAIL',
  'PUSH_STAGING_ANDROID_FCM_CLIENT_EMAIL',
];
const PRODUCTION_ANDROID_FCM_PRIVATE_KEY_KEYS = [
  'PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY',
  'PUSH_ANDROID_FCM_PRIVATE_KEY',
  'PUSH_STAGING_ANDROID_FCM_PRIVATE_KEY',
];
const STAGING_ANDROID_FCM_PROJECT_ID_KEYS = [
  'PUSH_STAGING_ANDROID_FCM_PROJECT_ID',
  'PUSH_ANDROID_FCM_PROJECT_ID',
  'PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID',
];
const STAGING_ANDROID_FCM_CLIENT_EMAIL_KEYS = [
  'PUSH_STAGING_ANDROID_FCM_CLIENT_EMAIL',
  'PUSH_ANDROID_FCM_CLIENT_EMAIL',
  'PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL',
];
const STAGING_ANDROID_FCM_PRIVATE_KEY_KEYS = [
  'PUSH_STAGING_ANDROID_FCM_PRIVATE_KEY',
  'PUSH_ANDROID_FCM_PRIVATE_KEY',
  'PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY',
];

function androidFcmEnvHint(target) {
  const projectKeys = target === 'production' ? PRODUCTION_ANDROID_FCM_PROJECT_ID_KEYS : STAGING_ANDROID_FCM_PROJECT_ID_KEYS;
  const emailKeys = target === 'production' ? PRODUCTION_ANDROID_FCM_CLIENT_EMAIL_KEYS : STAGING_ANDROID_FCM_CLIENT_EMAIL_KEYS;
  const privateKeys = target === 'production' ? PRODUCTION_ANDROID_FCM_PRIVATE_KEY_KEYS : STAGING_ANDROID_FCM_PRIVATE_KEY_KEYS;
  return `need one of each: ${projectKeys.join(' | ')}, ${emailKeys.join(' | ')}, ${privateKeys.join(' | ')}`;
}

function androidFcmConfigHelp(target) {
  const hint = androidFcmEnvHint(target);
  if (target === 'production') {
    return (
      `${hint}. Local send-test reads repo-root .env.dev (PUSH_PRODUCTION_ANDROID_FCM_* preferred; `
      + `PUSH_STAGING_ANDROID_FCM_* is accepted when production keys are unset — same Firebase project). `
      + `The live scheduler worker uses Cloudflare secrets PUSH_ANDROID_FCM_* synced from `
      + `PUSH_PRODUCTION_ANDROID_FCM_* via set-github-secrets.ps1 or terraform-production.yml — `
      + `run: pwsh scripts/set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction`
    );
  }
  return `${hint}. Staging scheduler does not send Android FCM; use --target production for Android rows.`;
}


function parseArgs() {
  const argv = process.argv.slice(2);
  let target = 'staging';
  let subscriptionId = '';
  let endpoint = '';
  let mine = false;
  let url = '';
  let title = '';
  let body = '';
  let slug = '';
  let articleId = '';
  let dryRun = false;
  let force = false;
  const warnings = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' && argv[i + 1]) { target = argv[++i].trim().toLowerCase(); continue; }
    if (arg === '--subscription-id' && argv[i + 1]) { subscriptionId = argv[++i].trim(); continue; }
    if (arg === '--endpoint' && argv[i + 1]) { endpoint = argv[++i].trim(); continue; }
    if (arg === '--mine') { mine = true; continue; }
    if (arg === '--url' && argv[i + 1]) { url = argv[++i].trim(); continue; }
    if (arg === '--title' && argv[i + 1]) { title = argv[++i].trim(); continue; }
    if (arg === '--body' && argv[i + 1]) { body = argv[++i].trim(); continue; }
    if (arg === '--slug' && argv[i + 1]) { slug = argv[++i].trim(); continue; }
    if (arg === '--article-id' && argv[i + 1]) { articleId = argv[++i].trim(); continue; }
    if (arg === '--article') {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        slug = argv[++i].trim();
      } else {
        throw new Error('--article requires a slug value (--article <slug>) or use --slug / --article-id');
      }
      continue;
    }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--force') { force = true; continue; }
  }

  if (!subscriptionId && !endpoint && !mine) {
    throw new Error('Specify one target: --subscription-id <uuid> | --endpoint <prefix> | --mine');
  }
  if ([subscriptionId, endpoint, mine].filter(Boolean).length > 1) {
    throw new Error('Use only one of --subscription-id, --endpoint, or --mine');
  }
  if (target !== 'staging' && target !== 'production') {
    throw new Error('--target must be staging or production');
  }
  if (slug && articleId) {
    throw new Error('Use only one of --slug / --article or --article-id');
  }

  const articleMode = Boolean(slug || articleId);
  if (!articleMode && (url || title || body)) {
    warnings.push(
      '[send-test] --url/--title/--body build a generic test payload (no featured image, tag article-test-*). '
      + 'For production-like article notifications use --slug <post-slug> or --article <post-slug>.',
    );
  }
  if (articleMode && (url || title || body)) {
    warnings.push('[send-test] ignoring --url/--title/--body in article mode (using buildArticlePushPayload from recent-posts feed).');
  }

  return {
    target,
    subscriptionId,
    endpoint,
    mine,
    url,
    title,
    body,
    slug,
    articleId,
    dryRun,
    force,
    articleMode,
    warnings,
  };
}

function pushBindingsForTarget(target, turso) {
  if (target === 'staging') {
    return {
      subscriptionsUrl: turso.url,
      subscriptionsToken: turso.token,
      siteOrigin: STAGING_SITE_ORIGIN,
      vapidPublic: pickFirstEnv(['PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY', 'PUSH_VAPID_PUBLIC_KEY']),
      vapidPrivate: pickFirstEnv(['PUSH_STAGING_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PRIVATE_KEY']),
      vapidSubject: pickFirstEnv(['PUSH_STAGING_VAPID_SUBJECT', 'PUSH_VAPID_SUBJECT']),
      androidFcmProjectId: pickFirstEnvOptional(STAGING_ANDROID_FCM_PROJECT_ID_KEYS),
      androidFcmClientEmail: pickFirstEnvOptional(STAGING_ANDROID_FCM_CLIENT_EMAIL_KEYS),
      androidFcmPrivateKey: pickFirstEnvOptional(STAGING_ANDROID_FCM_PRIVATE_KEY_KEYS),
      iosApnsTeamId: pickFirstEnvOptional(['PUSH_STAGING_IOS_APNS_TEAM_ID']),
      iosApnsKeyId: pickFirstEnvOptional(['PUSH_STAGING_IOS_APNS_KEY_ID']),
      iosApnsPrivateKey: pickFirstEnvOptional(['PUSH_STAGING_IOS_APNS_PRIVATE_KEY']),
      iosApnsBundleId: pickFirstEnvOptional(['PUSH_STAGING_IOS_APNS_BUNDLE_ID']),
      iosApnsHost: STAGING_IOS_APNS_HOST,
    };
  }
  return {
    subscriptionsUrl: turso.url,
    subscriptionsToken: turso.token,
    siteOrigin: PRODUCTION_SITE_ORIGIN,
    vapidPublic: pickFirstEnv(['PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY', 'PUSH_VAPID_PUBLIC_KEY']),
    vapidPrivate: pickFirstEnv(['PUSH_PRODUCTION_VAPID_PRIVATE_KEY', 'PUSH_VAPID_PRIVATE_KEY']),
    vapidSubject: pickFirstEnv(['PUSH_PRODUCTION_VAPID_SUBJECT', 'PUSH_VAPID_SUBJECT']),
    androidFcmProjectId: pickFirstEnvOptional(PRODUCTION_ANDROID_FCM_PROJECT_ID_KEYS),
    androidFcmClientEmail: pickFirstEnvOptional(PRODUCTION_ANDROID_FCM_CLIENT_EMAIL_KEYS),
    androidFcmPrivateKey: pickFirstEnvOptional(PRODUCTION_ANDROID_FCM_PRIVATE_KEY_KEYS),
    iosApnsTeamId: pickFirstEnvOptional(['PUSH_PRODUCTION_IOS_APNS_TEAM_ID']),
    iosApnsKeyId: pickFirstEnvOptional(['PUSH_PRODUCTION_IOS_APNS_KEY_ID']),
    iosApnsPrivateKey: pickFirstEnvOptional(['PUSH_PRODUCTION_IOS_APNS_PRIVATE_KEY']),
    iosApnsBundleId: pickFirstEnvOptional(['PUSH_PRODUCTION_IOS_APNS_BUNDLE_ID']),
    iosApnsHost: DEFAULT_IOS_APNS_HOST,
  };
}

/** Scheduler worker env shape (PUSH_* names match wrangler secrets). */
function schedulerEnvFromBindings(bindings) {
  return {
    PUSH_VAPID_PUBLIC_KEY: bindings.vapidPublic.value,
    PUSH_VAPID_PRIVATE_KEY: bindings.vapidPrivate.value,
    PUSH_VAPID_SUBJECT: bindings.vapidSubject.value,
    PUSH_ANDROID_FCM_PROJECT_ID: bindings.androidFcmProjectId?.value ?? '',
    PUSH_ANDROID_FCM_CLIENT_EMAIL: bindings.androidFcmClientEmail?.value ?? '',
    PUSH_ANDROID_FCM_PRIVATE_KEY: bindings.androidFcmPrivateKey?.value ?? '',
    PUSH_ANDROID_FCM_CHANNEL_ID: DEFAULT_ANDROID_CHANNEL_ID,
    PUSH_IOS_APNS_TEAM_ID: bindings.iosApnsTeamId?.value ?? '',
    PUSH_IOS_APNS_KEY_ID: bindings.iosApnsKeyId?.value ?? '',
    PUSH_IOS_APNS_PRIVATE_KEY: bindings.iosApnsPrivateKey?.value ?? '',
    PUSH_IOS_APNS_BUNDLE_ID: bindings.iosApnsBundleId?.value ?? '',
    PUSH_IOS_APNS_HOST: bindings.iosApnsHost,
  };
}

async function fetchRecentPost(siteOrigin, { slug, articleId }) {
  const origin = siteOrigin.trim().replace(/\/$/, '');
  const feedUrl = `${origin}/api/recent-published-posts.json`;
  const response = await fetch(feedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch recent posts from ${feedUrl}: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.posts || !Array.isArray(data.posts)) {
    throw new Error('Invalid response format from recent posts API');
  }
  const post = articleId
    ? data.posts.find((row) => row.id === articleId)
    : data.posts.find((row) => row.slug === slug);
  if (!post) {
    const key = articleId ? `id=${articleId}` : `slug=${slug}`;
    throw new Error(`No post with ${key} in recent feed at ${feedUrl} (limit 25 published posts)`);
  }
  return post;
}

async function resolvePayload(siteOrigin, options) {
  if (options.articleMode) {
    const post = await fetchRecentPost(siteOrigin, {
      slug: options.slug,
      articleId: options.articleId,
    });
    return { payload: buildArticlePushPayload(siteOrigin, post), mode: 'article', post, feedOrigin: siteOrigin };
  }
  return { payload: buildTestPayload(siteOrigin, options), mode: 'generic', post: null, feedOrigin: null };
}

function resolveAbsoluteNotificationUrl(siteOrigin, url) {
  const trimmed = url.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed;
  }
  const origin = siteOrigin.trim().replace(/\/$/, '');
  if (trimmed.startsWith('/')) {
    return `${origin}${trimmed}`;
  }
  return `${origin}/${trimmed}`;
}

function buildTestPayload(siteOrigin, options) {
  const origin = siteOrigin.trim().replace(/\/$/, '');
  const postSlug = options.slug?.trim() ?? '';
  const postUrl = options.url?.trim() || (postSlug ? `/posts/${postSlug}` : '/');
  return {
    title: options.title?.trim() || (postSlug ? `Test: ${postSlug}` : 'Freedom Times test notification'),
    body: options.body?.trim() || (postSlug ? 'Tap to open this post (Freedom Times test push).' : 'If you can read this, web push delivery works. Tap to open the site.'),
    url: postUrl,
    icon: `${origin}/favicon.svg`,
    badge: `${origin}/favicon.svg`,
    tag: postSlug ? `article-test-${postSlug}` : 'freedomtimes-test',
    ttl: 86_400,
    urgency: 'high',
  };
}

async function loadSubscription(client, { subscriptionId, endpoint, mine }) {
  if (subscriptionId) {
    const res = await client.execute({
      sql: 'SELECT id, endpoint, subscription_json, active FROM push_subscriptions WHERE id = ? LIMIT 1',
      args: [subscriptionId],
    });
    if (res.rows.length === 0) throw new Error(`No subscription with id=${subscriptionId}`);
    return res.rows[0];
  }
  if (endpoint) {
    const res = await client.execute({
      sql: 'SELECT id, endpoint, subscription_json, active FROM push_subscriptions WHERE endpoint LIKE ? ORDER BY datetime(updated_at) DESC LIMIT 1',
      args: [`${endpoint}%`],
    });
    if (res.rows.length === 0) throw new Error(`No subscription matching endpoint prefix: ${endpoint}`);
    return res.rows[0];
  }
  const res = await client.execute(
    'SELECT id, endpoint, subscription_json, active FROM push_subscriptions WHERE active = 1 ORDER BY datetime(updated_at) DESC',
  );
  if (res.rows.length === 0) throw new Error('No active subscriptions in database');
  if (res.rows.length > 1) {
    console.error(`--mine found ${res.rows.length} active subscriptions; pick one with --subscription-id:`);
    console.table(res.rows.map((row) => ({ id: row.id, endpoint_prefix: String(row.endpoint).slice(0, 70), active: row.active })));
    throw new Error('Multiple active subscriptions; use --subscription-id');
  }
  return res.rows[0];
}

async function markSuccess(client, id) {
  await client.execute({
    sql: 'UPDATE push_subscriptions SET last_success_at = CURRENT_TIMESTAMP, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    args: [id],
  });
}

async function markFailure(client, id, reason, deactivate) {
  await client.execute({
    sql: 'UPDATE push_subscriptions SET last_failure_at = CURRENT_TIMESTAMP, last_failure_reason = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    args: [reason.slice(0, 1000), deactivate ? 0 : 1, id],
  });
}

function logCredentialSources(bindings, platform) {
  if (platform === 'web') {
    console.log('[send-test] vapid public key from:', bindings.vapidPublic.name);
    return;
  }
  if (platform === 'android') {
    console.log('[send-test] FCM project id from:', bindings.androidFcmProjectId?.name ?? '(missing)');
    console.log('[send-test] FCM client email from:', bindings.androidFcmClientEmail?.name ?? '(missing)');
    return;
  }
  if (platform === 'ios') {
    console.log('[send-test] APNs team id from:', bindings.iosApnsTeamId?.name ?? '(missing)');
    console.log('[send-test] APNs key id from:', bindings.iosApnsKeyId?.name ?? '(missing)');
    console.log('[send-test] APNs bundle id from:', bindings.iosApnsBundleId?.name ?? '(missing)');
    console.log('[send-test] APNs host:', bindings.iosApnsHost);
  }
}

loadEnvDev();
const args = parseArgs();
for (const warning of args.warnings) {
  console.warn(warning);
}

const turso = subscriptionsBindingsForTarget(args.target);
if (args.target === 'production' && turso.fellBackToStaging) {
  console.error('[send-test] REFUSED: --target production but Turso bindings fell back to staging DB.');
  console.error('[send-test] Missing production subscriptions token in .env.dev (TURSO_SUBSCRIPTIONS_AUTH_TOKEN or TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN).');
  console.error('[send-test] Run: pwsh scripts/sync-production-turso-env-dev.ps1');
  process.exit(1);
}

const bindings = pushBindingsForTarget(args.target, turso);
const schedulerEnv = schedulerEnvFromBindings(bindings);
const webPushConfig = readWebPushConfig(schedulerEnv);
const androidPushConfig = readAndroidPushConfig(schedulerEnv);
const iosPushConfig = readIosPushConfig(schedulerEnv);
const client = createClient({ url: bindings.subscriptionsUrl.value, authToken: bindings.subscriptionsToken.value });

try {
  const row = await loadSubscription(client, args);
  const storedId = String(row.id);
  const storedEndpoint = String(row.endpoint);
  const active = Number(row.active) === 1;
  if (!active && !args.force) {
    console.error(`[send-test] subscription id=${storedId} is inactive (active=0).`);
    console.error('[send-test] Run `npm run subscriptions:inspect -- staging` and use the newest active row, or re-subscribe on the site.');
    process.exit(1);
  }
  if (!active && args.force) console.warn(`[send-test] --force: sending to inactive subscription id=${storedId}`);

  const parsedTarget = parseStoredTarget(String(row.subscription_json));
  if (!parsedTarget) throw new Error('Invalid subscription_json in database');

  let { payload, mode, post, feedOrigin } = await resolvePayload(bindings.siteOrigin, args);
  if (
    mode === 'generic'
    && (parsedTarget.platform === 'android' || parsedTarget.platform === 'ios')
    && payload.url
    && !payload.url.startsWith('https://')
    && !payload.url.startsWith('http://')
  ) {
    payload = { ...payload, url: resolveAbsoluteNotificationUrl(bindings.siteOrigin, payload.url) };
  }
  console.log('[send-test] target environment:', args.target);
  console.log('[send-test] site origin (feed + payload):', bindings.siteOrigin);
  console.log('[send-test] delivery platform:', parsedTarget.platform);
  if (mode === 'article') {
    console.log('[send-test] recent-posts feed:', `${feedOrigin}/api/recent-published-posts.json`);
  }
  console.log('[send-test] turso subscriptions url from:', bindings.subscriptionsUrl.name);
  console.log('[send-test] subscription:', {
    id: storedId,
    platform: parsedTarget.platform,
    endpoint_prefix: storedEndpoint.slice(0, 72),
    active,
  });
  if (mode === 'article') {
    console.log('[send-test] payload mode: production article (same builder as scheduler)', {
      articleId: post.id,
      slug: post.slug,
      tag: payload.tag,
      hasImage: Boolean(payload.image),
    });
  } else {
    console.log('[send-test] payload mode: generic test');
  }
  console.log('[send-test] payload:', payload);
  logCredentialSources(bindings, parsedTarget.platform);

  if (args.dryRun) {
    console.log('[send-test] dry-run: not sending');
    process.exit(0);
  }

  if (parsedTarget.platform === 'android' && !androidPushConfig) {
    console.error(`[send-test] Android FCM not configured in .env.dev (${androidFcmConfigHelp(args.target)})`);
    process.exit(1);
  }
  if (parsedTarget.platform === 'ios' && !iosPushConfig) {
    const prefix = args.target === 'production' ? 'PUSH_PRODUCTION_IOS_APNS_' : 'PUSH_STAGING_IOS_APNS_';
    console.error(`[send-test] iOS APNs not configured in .env.dev (need ${prefix}TEAM_ID, _KEY_ID, _PRIVATE_KEY, _BUNDLE_ID)`);
    process.exit(1);
  }
  if (parsedTarget.platform === 'web' && !webPushConfig) {
    console.error('[send-test] Web VAPID not configured in .env.dev for this target');
    process.exit(1);
  }

  let applicationServerKeysPromise = null;
  let googleAccessTokenPromise = null;
  let apnsTokenPromise = null;

  const result = await deliverToStoredTarget({
    target: parsedTarget,
    payload,
    webPushConfig,
    androidPushConfig,
    iosPushConfig,
    getApplicationServerKeys: () => {
      if (!applicationServerKeysPromise) {
        applicationServerKeysPromise = createApplicationServerKeys(webPushConfig);
      }
      return applicationServerKeysPromise;
    },
    getGoogleAccessToken: () => {
      if (!googleAccessTokenPromise) {
        googleAccessTokenPromise = createGoogleAccessToken(androidPushConfig);
      }
      return googleAccessTokenPromise;
    },
    getApnsToken: () => {
      if (!apnsTokenPromise) {
        apnsTokenPromise = createApnsToken(iosPushConfig);
      }
      return apnsTokenPromise;
    },
  });

  if (result.ok) {
    await markSuccess(client, storedId);
    console.log(`[send-test] delivered ok (platform=${parsedTarget.platform}); last_success_at updated`);
    const tapUrl = /^https?:\/\//i.test(payload.url)
      ? payload.url
      : new URL(payload.url, bindings.siteOrigin).href;
    console.log('[send-test] tap the notification — it should open:', tapUrl);
    process.exit(0);
  }

  const reason = result.reason ?? 'Push delivery failed';
  await markFailure(client, storedId, reason, result.deactivate);
  console.error(`[send-test] delivery failed: ${reason}`);
  if (result.deactivate) console.error('[send-test] subscription marked inactive (token/endpoint gone)');
  process.exit(1);
} finally {
  client.close();
}
