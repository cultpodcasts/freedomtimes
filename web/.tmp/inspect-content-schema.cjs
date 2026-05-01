const { createClient } = require("@libsql/client");

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const t = await db.execute("pragma table_info('ec_posts')");
  console.log(JSON.stringify(t.rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
