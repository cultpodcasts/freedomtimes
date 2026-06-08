/**
 * Marks published posts as already notified in `sent_article_notifications` so the scheduler
 * will not send retroactive pushes. Uses the public recent-posts JSON feed + subscriptions Turso DB.
 *
 * Usage (from web/):
 *   npx tsx scripts/backfill-sent-article-notifications.ts --origin https://freedomtimes.news
 *
 * Env: TURSO_SUBSCRIPTIONS_DATABASE_URL (+ TURSO_STAGING_* fallback) and matching AUTH_TOKEN — same as apply-turso-sql.
 * If unset, loads repo-root `.env.dev` when present (does not override existing process.env).
 */
import { createClient } from '@libsql/client';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type PostRow = { id: string };

function loadEnvDevIfNeeded(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const envPath = path.join(repoRoot, '.env.dev');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val;
    }
  }
  console.log('[backfill-sent] loaded .env.dev (fills only empty env vars)');
}

function pickFirstEnv(names: string[]): { name: string; value: string } {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { name, value };
  }
  throw new Error(`${names.join(' or ')} is required`);
}

function parseArgs(): { origin: string } {
  const argv = process.argv.slice(2);
  let origin = 'https://freedomtimes.news';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--origin' && argv[i + 1]) {
      origin = argv[i + 1].replace(/\/$/, '');
      i++;
    }
  }
  return { origin };
}

async function main(): Promise<void> {
  loadEnvDevIfNeeded();
  const { origin } = parseArgs();
  const urlBinding = pickFirstEnv(['TURSO_SUBSCRIPTIONS_DATABASE_URL', 'TURSO_STAGING_SUBSCRIPTIONS_DB_URL']);
  const tokenBinding = pickFirstEnv(['TURSO_SUBSCRIPTIONS_AUTH_TOKEN', 'TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN']);
  const feedUrl = `${origin}/api/recent-published-posts.json`;
  console.log(`[backfill-sent] subscriptions: ${urlBinding.name} + ${tokenBinding.name}`);
  console.log(`[backfill-sent] feed: ${feedUrl}`);

  const feedRes = await fetch(feedUrl);
  if (!feedRes.ok) {
    throw new Error(`Feed HTTP ${feedRes.status}: ${feedRes.statusText}`);
  }
  const data = (await feedRes.json()) as { posts?: PostRow[] };
  const posts = data.posts ?? [];
  if (posts.length === 0) {
    console.log('[backfill-sent] no posts in feed; nothing to insert');
    return;
  }

  const client = createClient({ url: urlBinding.value, authToken: tokenBinding.value });
  try {
    let attempts = 0;
    for (const post of posts) {
      const id = typeof post.id === 'string' ? post.id.trim() : '';
      if (!id) continue;
      await client.execute({
        sql: `INSERT OR IGNORE INTO sent_article_notifications (article_id, sent_at) VALUES (?, datetime('now'))`,
        args: [id],
      });
      attempts++;
    }
    console.log(`[backfill-sent] INSERT OR IGNORE for ${attempts} article_id(s) from ${posts.length} feed row(s)`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
