const { createClient } = require("@libsql/client");

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const bylineId = "01KQCYVH054FC4H1GH9TYBQEG7";
  const postSlug = "pbcc-plymouth-brethren-cult-in-plain-sight-what-unchosen-shows-us-about-hidden-c-1";

  const post = await db.execute({
    sql: "select id from ec_posts where slug = ? limit 1",
    args: [postSlug],
  });
  if (!post.rows.length) {
    throw new Error(`Post not found: ${postSlug}`);
  }
  const postId = post.rows[0].id;

  await db.execute({
    sql: `insert or ignore into _emdash_bylines
      (id, slug, display_name, is_guest, created_at, updated_at)
      values (?, ?, ?, 1, datetime('now'), datetime('now'))`,
    args: [bylineId, "he-who-shant-be-named", "He Who Shan't Be Named"],
  });

  await db.execute({
    sql: `insert or ignore into _emdash_content_bylines
      (id, collection_slug, content_id, byline_id, sort_order, role_label, created_at)
      values (?, 'posts', ?, ?, 0, 'Freelance Journalist', datetime('now'))`,
    args: [`bylrel-${postId}`, postId, bylineId],
  });

  await db.execute({
    sql: "update ec_posts set primary_byline_id = ? where id = ?",
    args: [bylineId, postId],
  });

  console.log(JSON.stringify({ postId, bylineId, restored: true }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
