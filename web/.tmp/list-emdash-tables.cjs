const { createClient } = require("@libsql/client");

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const r = await db.execute("select name from sqlite_master where type='table' order by name");
  console.log(JSON.stringify(r.rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
