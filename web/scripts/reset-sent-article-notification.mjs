/**
 * Remove one article from sent_article_notifications so the scheduler can retry pushes.
 * Backup the subscriptions Turso DB before running (see web/CONTENT_PROMOTION_RUNBOOK.md).
 *
 * Usage (from web/):
 *   node scripts/reset-sent-article-notification.mjs --article-id weekly-summary-22-june-2026
 *   node scripts/reset-sent-article-notification.mjs --article-id weekly-summary-22-june-2026 --target staging
 */
import { createClient } from '@libsql/client';
import { loadEnvDev } from './lib/load-env-dev.mjs';
import { subscriptionsBindingsForTarget } from './lib/turso-env-bindings.mjs';

function parseArgs() {
  const argv = process.argv.slice(2);
  let articleId = '';
  let target = 'production';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--article-id' && argv[i + 1]) {
      articleId = argv[i + 1].trim();
      i++;
      continue;
    }
    if (argv[i] === '--target' && argv[i + 1]) {
      target = argv[i + 1].trim().toLowerCase();
      i++;
    }
  }
  if (!articleId) {
    throw new Error('Usage: node scripts/reset-sent-article-notification.mjs --article-id <slug-or-emdash-id> [--target production|staging]');
  }
  return { articleId, target };
}

loadEnvDev();
const { articleId, target } = parseArgs();
const bindings = subscriptionsBindingsForTarget(target);

const client = createClient({ url: bindings.url.value, authToken: bindings.token.value });
try {
  const result = await client.execute({
    sql: 'DELETE FROM sent_article_notifications WHERE article_id = ?',
    args: [articleId],
  });
  console.log(`[reset-sent] target=${target} article_id=${articleId} rowsDeleted=${result.rowsAffected ?? 0}`);
} finally {
  client.close();
}
