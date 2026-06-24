/**
 * Compare VAPID public key fingerprints (length + prefix/suffix only — never prints full secrets).
 *
 * Usage (from web/):
 *   npm run subscriptions:compare-vapid-keys -- staging
 *   npm run subscriptions:compare-vapid-keys -- staging --origin https://staging.freedomtimes.news/posts/weekly-summary-22-june-2026
 *
 * Checks:
 * - `.env.dev` PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY (or production equivalent)
 * - Optional deployed page `data-public-key` on the web worker (login may be required)
 *
 * Wrangler secret values cannot be read back; CI syncs the same GitHub secret to:
 * - web worker: PUSH_SUBSCRIBE_PUBLIC_KEY
 * - scheduler worker: PUSH_VAPID_PUBLIC_KEY
 */
import { loadEnvDev, pickFirstEnv } from './lib/load-env-dev.mjs';

function fingerprint(value, label) {
  const trimmed = value.trim();
  if (!trimmed) {
    return { label, present: false };
  }
  return {
    label,
    present: true,
    length: trimmed.length,
    prefix: trimmed.slice(0, 12),
    suffix: trimmed.slice(-8),
  };
}

function formatFingerprint(fp) {
  if (!fp.present) return `${fp.label}: (missing)`;
  return `${fp.label}: len=${fp.length} prefix=${fp.prefix}...${fp.suffix}`;
}

function keysForTarget(target) {
  if (target === 'staging') {
    return {
      envPublic: pickFirstEnv(['PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY', 'PUSH_VAPID_PUBLIC_KEY']),
      defaultOrigin: 'https://staging.freedomtimes.news',
      workerSecretName: 'PUSH_SUBSCRIBE_PUBLIC_KEY',
      schedulerSecretName: 'PUSH_VAPID_PUBLIC_KEY',
    };
  }
  if (target === 'production') {
    return {
      envPublic: pickFirstEnv(['PUSH_PRODUCTION_SUBSCRIBE_PUBLIC_KEY', 'PUSH_VAPID_PUBLIC_KEY']),
      defaultOrigin: 'https://freedomtimes.news',
      workerSecretName: 'PUSH_SUBSCRIBE_PUBLIC_KEY',
      schedulerSecretName: 'PUSH_VAPID_PUBLIC_KEY',
    };
  }
  throw new Error('Usage: node scripts/compare-push-vapid-keys.mjs <staging|production> [--origin <url>]');
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let target = (argv[0] || 'staging').trim().toLowerCase();
  let origin = '';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--origin' && argv[i + 1]) {
      origin = argv[++i].trim();
      continue;
    }
    if (!origin && i === 0 && !argv[i].startsWith('--')) {
      target = argv[i].trim().toLowerCase();
    }
  }

  return { target, origin };
}

async function readDeployedPublicKey(origin) {
  const response = await fetch(origin, {
    headers: { accept: 'text/html' },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`GET ${origin} returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const match = html.match(/data-public-key="([^"]+)"/);
  if (!match) {
    return null;
  }

  return match[1].trim();
}

loadEnvDev();
const { target, origin: originArg } = parseArgs();
const bindings = keysForTarget(target);
const envFp = fingerprint(bindings.envPublic.value, bindings.envPublic.name);

console.log(`\nVAPID public key comparison (${target})`);
console.log(formatFingerprint(envFp));
console.log(`\nExpected worker secrets (same value as ${bindings.envPublic.name}):`);
console.log(`  freedomtimes-holding-${target === 'production' ? 'production' : 'staging'} → ${bindings.workerSecretName}`);
console.log(`  freedomtimes-scheduler-${target === 'production' ? 'production' : 'staging'} → ${bindings.schedulerSecretName}`);
console.log('  (wrangler cannot print secret values; re-sync from .env.dev / GitHub if fingerprints diverge)');

const origin = originArg || bindings.defaultOrigin;
try {
  const deployedKey = await readDeployedPublicKey(origin);
  if (!deployedKey) {
    console.log(`\nDeployed page (${origin}): no data-public-key in HTML (auth wall, missing callout, or empty PUSH_SUBSCRIBE_PUBLIC_KEY secret)`);
  } else {
    const deployedFp = fingerprint(deployedKey, 'deployed data-public-key');
    console.log(`\n${formatFingerprint(deployedFp)}`);
    const match = envFp.present
      && deployedFp.present
      && envFp.prefix === deployedFp.prefix
      && envFp.suffix === deployedFp.suffix
      && envFp.length === deployedFp.length;
    console.log(match ? '\nOK: .env.dev public key matches deployed subscribe key.' : '\nMISMATCH: .env.dev public key does NOT match deployed subscribe key. Re-sync worker secrets and have users re-subscribe.');
  }
} catch (error) {
  console.log(`\nDeployed page (${origin}): could not fetch — ${error.message}`);
  console.log('Open a post on staging while logged in and inspect #notifications-enable data-public-key in DevTools if needed.');
}
