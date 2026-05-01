const { createClient } = require("@libsql/client");

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const t1 = await db.execute("pragma table_info('_emdash_bylines')");
  const t2 = await db.execute("pragma table_info('_emdash_content_bylines')");
  console.log("bylines", JSON.stringify(t1.rows, null, 2));
  console.log("content_bylines", JSON.stringify(t2.rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
