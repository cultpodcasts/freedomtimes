const fs = require("fs");
const { createClient } = require("@libsql/client");

async function main() {
  const [url, token, sqlPath] = process.argv.slice(2);
  if (!url || !token || !sqlPath) {
    throw new Error("Usage: node run-sql-file.cjs <url> <token> <sqlPath>");
  }

  const sql = fs.readFileSync(sqlPath, "utf8");
  const sqlWithoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = sqlWithoutComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s);

  const client = createClient({ url, authToken: token });
  for (const statement of statements) {
    await client.execute(statement);
  }
  client.close();
  console.log(`Applied ${statements.length} statements from ${sqlPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
