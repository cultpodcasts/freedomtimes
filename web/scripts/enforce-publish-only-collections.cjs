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
    "select slug, supports from _emdash_collections order by slug"
  );
  console.log(JSON.stringify(rows.rows, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
