/**
 * Read-only inspection of push subscription + scheduler state in Turso.
 *
 * Usage (from web/):
 *   npm run subscriptions:inspect -- staging
 *   npm run subscriptions:list -- staging
 *   npm run subscriptions:list -- staging --web --active
 *
 * Credentials: repo-root `.env.dev` (see scripts/lib/turso-env-bindings.mjs).
 */
import { createClient } from '@libsql/client';
import {
  enhanceTursoConnectError,
  loadEnvDev,
} from './lib/load-env-dev.mjs';
import { bindingsForTarget } from './lib/turso-env-bindings.mjs';

const RECENT_SUBSCRIPTIONS_SQL = `
  SELECT
    id,
    COALESCE(json_extract(subscription_json, '$.platform'), 'web') AS platform,
    substr(endpoint, 1, 52) AS endpoint_prefix,
    active,
    substr(COALESCE(user_agent, ''), 1, 64) AS user_agent,
    created_at,
    updated_at,
    last_success_at,
    substr(COALESCE(last_failure_reason, ''), 1, 72) AS fail_reason
  FROM push_subscriptions
`;

function parseArgs(argv) {
  let target = 'staging';
  let listOnly = false;
  let webOnly = false;
  let activeOnly = false;
  let limit = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') {
      listOnly = true;
      continue;
    }
    if (arg === '--web') {
      webOnly = true;
      continue;
    }
    if (arg === '--active') {
      activeOnly = true;
      continue;
    }
    if (arg === '--limit' && argv[i + 1]) {
      limit = Number.parseInt(argv[++i], 10);
      continue;
    }
    if (arg === 'staging' || arg === 'production') {
      target = arg;
    }
  }

  if (limit === null || Number.isNaN(limit) || limit < 1) {
    limit = listOnly ? 25 : 10;
  }

  return { target, listOnly, webOnly, activeOnly, limit };
}

function buildSubscriptionListSql({ webOnly, activeOnly, limit }) {
  const clauses = [];
  if (activeOnly) {
    clauses.push('active = 1');
  }
  if (webOnly) {
    clauses.push(
      "(COALESCE(json_extract(subscription_json, '$.platform'), 'web') = 'web')",
    );
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return `${RECENT_SUBSCRIPTIONS_SQL} ${where} ORDER BY datetime(updated_at) DESC LIMIT ${limit}`;
}

async function executeOrExplain(client, context, sql) {
  try {
    return await client.execute(sql);
  } catch (error) {
    throw enhanceTursoConnectError(error, context);
  }
}

async function listSubscriptions(bindings, options) {
  const context = {
    urlBindingName: bindings.subscriptionsUrl.name,
    url: bindings.subscriptionsUrl.value,
  };
  const client = createClient({
    url: bindings.subscriptionsUrl.value,
    authToken: bindings.subscriptionsToken.value,
  });

  const filters = [
    options.webOnly ? 'web only' : null,
    options.activeOnly ? 'active only' : null,
  ].filter(Boolean).join(', ') || 'all';

  console.log(`\nSubscriptions (${bindings.subscriptionsUrl.name}) — ${filters}, limit ${options.limit}`);
  console.log('Identify yours: match user_agent + endpoint_prefix + created_at after you click Enable.');
  const res = await executeOrExplain(client, context, buildSubscriptionListSql(options));
  console.table(res.rows);
  client.close();
}

async function inspectSubscriptions(bindings, options) {
  const context = {
    urlBindingName: bindings.subscriptionsUrl.name,
    url: bindings.subscriptionsUrl.value,
  };
  const client = createClient({
    url: bindings.subscriptionsUrl.value,
    authToken: bindings.subscriptionsToken.value,
  });

  const queries = [
    ['push_subscriptions total', 'SELECT COUNT(*) AS c FROM push_subscriptions'],
    ['push_subscriptions active', 'SELECT COUNT(*) AS c FROM push_subscriptions WHERE active = 1'],
    ['sent_article_notifications', 'SELECT COUNT(*) AS c FROM sent_article_notifications'],
    [
      'recent sent articles',
      "SELECT article_id, sent_at FROM sent_article_notifications ORDER BY datetime(sent_at) DESC LIMIT 10",
    ],
    [
      'recent subscriptions',
      buildSubscriptionListSql({ ...options, webOnly: false, activeOnly: false }),
    ],
    [
      'failure reason breakdown',
      "SELECT substr(COALESCE(last_failure_reason,'(none)'),1,100) AS reason, COUNT(*) AS c FROM push_subscriptions GROUP BY reason ORDER BY c DESC LIMIT 8",
    ],
    [
      'active never delivered',
      'SELECT COUNT(*) AS c FROM push_subscriptions WHERE active = 1 AND last_success_at IS NULL',
    ],
  ];

  console.log(`\nSubscriptions DB (${bindings.subscriptionsUrl.name})`);
  for (const [label, sql] of queries) {
    const res = await executeOrExplain(client, context, sql);
    console.log(`\n${label}:`);
    console.table(res.rows);
  }

  client.close();
}

async function inspectScheduler(bindings) {
  const context = {
    urlBindingName: bindings.schedulerUrl.name,
    url: bindings.schedulerUrl.value,
  };
  const client = createClient({
    url: bindings.schedulerUrl.value,
    authToken: bindings.schedulerToken.value,
  });

  const res = await executeOrExplain(
    client,
    context,
    "SELECT id, handler, interval_minutes, next_run_at, last_run_at, last_error, run_count, active FROM scheduler_jobs WHERE handler = 'send_article_notifications'",
  );

  console.log(`\nScheduler DB (${bindings.schedulerUrl.name})`);
  console.table(res.rows);
  client.close();
}

const args = parseArgs(process.argv.slice(2));
loadEnvDev();
const bindings = bindingsForTarget(args.target);

console.log(`Inspecting push notification state for: ${args.target}`);

if (args.listOnly) {
  await listSubscriptions(bindings, args);
} else {
  await inspectSubscriptions(bindings, args);
  await inspectScheduler(bindings);
}
