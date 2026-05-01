const { createClient } = require("@libsql/client");

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  await db.execute({
    sql: "update _emdash_fields set label = 'Subjects' where slug = 'subjects' and collection_id = (select id from _emdash_collections where slug = 'posts')",
  });

  await db.execute({
    sql: "delete from options where name = 'emdash:manifest_cache'",
  });

  const check = await db.execute({
    sql: "select slug, label from _emdash_fields where slug = 'subjects' and collection_id = (select id from _emdash_collections where slug = 'posts')",
  });

  console.log(JSON.stringify(check.rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
