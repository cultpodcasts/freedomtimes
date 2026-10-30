/**
 * EmDash staging policy: posts/pages publish-only (no drafts workflow).
 * Run from web/ so @libsql/client resolves. Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
 */
const { createClient } = require("@libsql/client");

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const label = process.env.EMDASH_PUBLISH_ONLY_LABEL || "target";

  if (!url || !authToken) {
    throw new Error(
      `Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN for ${label} publish-only enforcement.`
    );
  }

  const db = createClient({ url, authToken });
  await db.execute(
    "update _emdash_collections set supports = '[\"revisions\",\"search\"]', updated_at = datetime('now') where slug in ('posts', 'pages')"
  );

  const rows = await db.execute(
    "select slug from _emdash_collections where slug in ('posts', 'pages') and supports = '[\"revisions\",\"search\"]' order by slug"
  );
  // Collection names only: CI logs are public, so never print table rows
  // (web/docs/DEPLOY.md § Backups are never public).
  const enforced = rows.rows.map((row) => String(row.slug));
  console.log(`Publish-only supports set for ${label}: ${enforced.join(", ") || "(none found)"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
