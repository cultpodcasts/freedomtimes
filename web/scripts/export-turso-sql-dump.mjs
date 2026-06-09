#!/usr/bin/env node
/**
 * Recoverable SQL dump of a Turso/libSQL database using app URL + auth token.
 * Usage: node web/scripts/export-turso-sql-dump.mjs <output.sql>
 * Env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN (or pass via shell after loading .env.dev)
 */
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outPath = resolve(process.argv[2] ?? "");
const url = process.env.TURSO_DATABASE_URL?.trim();
const authToken = process.env.TURSO_AUTH_TOKEN?.trim();

if (!outPath) {
  console.error("Usage: node export-turso-sql-dump.mjs <output.sql>");
  process.exit(1);
}
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
  process.exit(1);
}

const db = createClient({ url, authToken });

function qIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function qLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

const tables = await db.execute(
  `SELECT name FROM sqlite_master
   WHERE type = 'table'
     AND name NOT LIKE 'sqlite_%'
     AND name NOT LIKE 'libsql_%'
   ORDER BY name`
);

const lines = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];

for (const row of tables.rows) {
  const name = String(row.name);
  const create = await db.execute(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
  const ddl = create.rows[0]?.sql;
  if (ddl) {
    lines.push(`${ddl};`);
  }

  const data = await db.execute(`SELECT * FROM ${qIdent(name)}`);
  for (const dataRow of data.rows) {
    const cols = data.columns.map((c) => qIdent(c)).join(", ");
    const vals = data.columns.map((c) => qLiteral(dataRow[c])).join(", ");
    lines.push(`INSERT INTO ${qIdent(name)} (${cols}) VALUES (${vals});`);
  }
}

lines.push("COMMIT;");
writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
console.log(outPath);
