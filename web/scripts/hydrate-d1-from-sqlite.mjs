#!/usr/bin/env node
/**
 * Copy a local SQLite EmDash export into an existing Cloudflare D1 database
 * using bound parameters (required: D1 SQL statements are capped at 100 KB, and
 * Freedom Times posts/revisions exceed that if inlined in a .dump).
 *
 * Does not create or delete the D1 database. Skips FTS shadow tables and
 * rebuilds FTS5 virtual tables after the base rows are loaded.
 *
 * Usage (repo root or web/):
 *   node web/scripts/hydrate-d1-from-sqlite.mjs --sqlite path.db --database-id <uuid>
 *
 * Auth: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (or TF_VAR_CLOUDFLARE_*).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const FTS_SHADOW_RE = /_(data|idx|content|docsize|config|insert|update|delete)$/;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) return null;
  return process.argv[i + 1];
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function loadWranglerOauthToken() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "xdg.config/.wrangler/config/default.toml"));
    candidates.push(path.join(process.env.APPDATA, ".wrangler/config/default.toml"));
  }
  if (process.env.HOME) {
    candidates.push(path.join(process.env.HOME, ".wrangler/config/default.toml"));
    candidates.push(path.join(process.env.HOME, ".config/.wrangler/config/default.toml"));
  }
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^\s*oauth_token\s*=\s*"([^"]+)"/m);
    if (m?.[1]) return m[1];
  }
  return null;
}

/**
 * D1 ignores PRAGMA foreign_keys=OFF (it stays on even in the same batch).
 * Strip FOREIGN KEY clauses from CREATE TABLE so rows can load out of
 * topological order. Unique / primary-key constraints are kept.
 */
function stripForeignKeys(sql) {
  let out = sql;
  out = out.replace(
    /,\s*constraint\s+"[^"]+"\s+foreign\s+key\s*\([^)]*\)\s+references\s+"[^"]+"\s*\([^)]*\)(?:\s+on\s+(?:delete|update)\s+(?:cascade|set null|restrict|no action))*/gi,
    "",
  );
  out = out.replace(
    /\s+references\s+"[^"]+"\s*\([^)]*\)(?:\s+on\s+(?:delete|update)\s+(?:cascade|set null|restrict|no action))*/gi,
    "",
  );
  return out;
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function isFtsVirtual(sql) {
  return /CREATE\s+VIRTUAL\s+TABLE/i.test(sql || "") && /USING\s+fts5/i.test(sql || "");
}

function isFtsShadow(name, ftsNames) {
  for (const fts of ftsNames) {
    if (name === fts) return false;
    if (name.startsWith(`${fts}_`) && FTS_SHADOW_RE.test(name.slice(fts.length))) return true;
  }
  return false;
}

function toParam(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) return Number(value);
    return value.toString();
  }
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Array.from(value);
  if (Buffer.isBuffer(value)) return Array.from(value);
  if (typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) return value.data;
  return String(value);
}

async function d1Request(accountId, token, databaseId, payload) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.success !== false) return body;
    const errText = JSON.stringify(body.errors || body.error || body);
    lastErr = new Error(`D1 query HTTP ${res.status}: ${errText}`);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 6) throw lastErr;
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw lastErr;
}

function d1Query(accountId, token, databaseId, sql, params = []) {
  return d1Request(accountId, token, databaseId, { sql, params });
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  loadEnvFile(path.join(repoRoot, ".env.dev"));

  const sqlitePath = arg("--sqlite");
  const databaseId = arg("--database-id");
  if (!sqlitePath || !databaseId) {
    console.error("Usage: node web/scripts/hydrate-d1-from-sqlite.mjs --sqlite <file.db> --database-id <uuid>");
    process.exit(2);
  }
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite file not found: ${sqlitePath}`);

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.TF_VAR_CLOUDFLARE_ACCOUNT_ID;
  let token = process.env.CLOUDFLARE_API_TOKEN || process.env.TF_VAR_CLOUDFLARE_API_TOKEN || "";
  let tokenSource = token ? "CLOUDFLARE_API_TOKEN" : "";
  // The Terraform Workers token in .env.dev does not include d1:write. Prefer
  // wrangler OAuth (d1:write) when the API token cannot list D1 databases.
  async function canUseD1(tok) {
    if (!tok || !accountId) return false;
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    return res.ok;
  }
  if (!(await canUseD1(token))) {
    const oauth = loadWranglerOauthToken();
    if (oauth && (await canUseD1(oauth))) {
      token = oauth;
      tokenSource = "wrangler oauth";
    }
  }
  if (!token || !accountId) throw new Error("Missing Cloudflare credentials / CLOUDFLARE_ACCOUNT_ID");
  if (!(await canUseD1(token))) {
    throw new Error("Cloudflare token cannot call the D1 API (need d1:write). Use wrangler login, not the Workers-only Terraform token.");
  }
  console.log(`Auth: ${tokenSource}`);

  const db = new DatabaseSync(path.resolve(sqlitePath), { readOnly: true });
  const all = (sql) => db.prepare(sql).all();

  const integrity = all("PRAGMA integrity_check")[0];
  const integrityVal = integrity.integrity_check ?? Object.values(integrity)[0];
  if (integrityVal !== "ok") throw new Error(`Source integrity_check failed: ${integrityVal}`);

  const objects = all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name");
  const ftsNames = objects.filter((o) => o.type === "table" && isFtsVirtual(o.sql)).map((o) => o.name);
  const tables = objects.filter((o) => o.type === "table" && o.name && !o.name.startsWith("sqlite_"));
  const baseTables = tables.filter((o) => !isFtsVirtual(o.sql) && !isFtsShadow(o.name, ftsNames));
  const ftsTables = tables.filter((o) => isFtsVirtual(o.sql));
  const indexes = objects.filter(
    (o) => o.type === "index" && o.sql && !o.name.startsWith("sqlite_") && !ftsNames.some((f) => o.tbl_name === f || o.name.startsWith(`${f}_`)),
  );

  console.log(`Source ${sqlitePath}`);
  console.log(`Base tables ${baseTables.length}, FTS virtual ${ftsTables.map((t) => t.name).join(", ") || "(none)"}`);

  const q = (sql, params = []) => d1Query(accountId, token, databaseId, sql, params);
  // D1 HTTP queries are stateless: foreign_keys defaults to ON each request, and
  // insert order is alphabetical, not topological. Keep FK checks off in the same
  // SQL string as the mutation (multi-statement is accepted).
  // Params cannot be combined with multi-statement SQL. Use the batch API so
  // PRAGMA foreign_keys=OFF and the INSERT share one request (stateless HTTP).
  const qNoFk = (sql, params = []) => d1Request(accountId, token, databaseId, {
    batch: [{ sql: "PRAGMA foreign_keys=OFF" }, { sql, params }],
  });

  // Wipe a previous partial load in this same D1 (idempotent re-run).
  process.stdout.write("Reset existing D1 objects... ");
  const existing = await q("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name IS NOT NULL");
  const existingRows = extractRows(existing);
  for (const row of existingRows.filter((r) => r.type === "table" && /VIRTUAL|fts5/i.test(String(r.name)))) {
    // name-only filter; actual virtual tables dropped below via type+later pass
  }
  const existingTables = existingRows.filter((r) => r.type === "table").map((r) => r.name);
  // Never drop D1/Cloudflare internals (_cf_KV) or sqlite_* system tables.
  const droppable = existingTables.filter((n) => n && !n.startsWith("sqlite_") && !n.startsWith("_cf_"));
  const dropList = [
    ...droppable.filter((n) => n.includes("_fts_")),
    ...droppable.filter((n) => !n.includes("_fts_")),
  ];
  for (const name of dropList) {
    await qNoFk(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  }
  console.log(`dropped ${dropList.length} tables`);

  // Schema: base tables
  for (const t of baseTables) {
    if (!t.sql) continue;
    process.stdout.write(`CREATE ${t.name}... `);
    await qNoFk(stripForeignKeys(t.sql));
    console.log("ok");
  }

  const sourceCounts = {};
  const destCounts = {};

  for (const t of baseTables) {
    const name = t.name;
    const cols = all(`PRAGMA table_info(${quoteIdent(name)})`).map((c) => c.name);
    const rows = all(`SELECT * FROM ${quoteIdent(name)}`);
    sourceCounts[name] = rows.length;
    process.stdout.write(`INSERT ${name} (${rows.length} rows)... `);
    const colList = cols.map(quoteIdent).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const insertSql = `INSERT INTO ${quoteIdent(name)} (${colList}) VALUES (${placeholders})`;
    const maxParams = 100;
    const maxBatchRows = Math.max(1, Math.floor(maxParams / Math.max(cols.length, 1)));
    const largeThreshold = 20_000;
    let i = 0;
    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      if (batch.length === 1) {
        await qNoFk(insertSql, batch[0]);
      } else {
        const valuesSql = batch.map(() => `(${placeholders})`).join(", ");
        const sql = `INSERT INTO ${quoteIdent(name)} (${colList}) VALUES ${valuesSql}`;
        await qNoFk(sql, batch.flat());
      }
      i += batch.length;
      batch = [];
      if (i % 100 === 0 || i === rows.length) process.stdout.write(`${i}... `);
    };
    for (const row of rows) {
      const params = cols.map((c) => toParam(row[c]));
      const bulky = params.some((v) => (typeof v === "string" && v.length >= largeThreshold) || (Array.isArray(v) && v.length >= largeThreshold));
      if (bulky) {
        await flush();
        await qNoFk(insertSql, params);
        i += 1;
        if (i % 100 === 0 || i === rows.length) process.stdout.write(`${i}... `);
        continue;
      }
      batch.push(params);
      if (batch.length >= maxBatchRows) await flush();
    }
    await flush();
    destCounts[name] = (await q(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`)).result?.[0]?.results?.[0]?.c;
    // CF wraps as result[0].results
    console.log(`ok source=${rows.length}`);
  }

  for (const idx of indexes) {
    process.stdout.write(`INDEX ${idx.name}... `);
    try {
      await qNoFk(idx.sql);
      console.log("ok");
    } catch (err) {
      if (/already exists/i.test(err.message)) console.log("exists");
      else throw err;
    }
  }

  // These FTS5 tables store their own content (no content=). REBUILD of an
  // empty virtual table stays empty — copy the source FTS rows instead.
  for (const t of ftsTables) {
    process.stdout.write(`FTS CREATE ${t.name}... `);
    await qNoFk(t.sql);
    console.log("ok");
    const cols = all(`PRAGMA table_info(${quoteIdent(t.name)})`).map((c) => c.name);
    const rows = all(`SELECT * FROM ${quoteIdent(t.name)}`);
    process.stdout.write(`FTS INSERT ${t.name} (${rows.length} rows)... `);
    const colList = cols.map(quoteIdent).join(", ");
    const placeholders = cols.map(() => "?").join(", ");
    const insertSql = `INSERT INTO ${quoteIdent(t.name)} (${colList}) VALUES (${placeholders})`;
    let i = 0;
    for (const row of rows) {
      await q(insertSql, cols.map((c) => toParam(row[c])));
      i += 1;
      if (i % 50 === 0 || i === rows.length) process.stdout.write(`${i}... `);
    }
    console.log("ok");
  }

  // Recount including FTS virtual row counts (not shadow)
  console.log("\nCOUNT COMPARISON");
  let mismatch = 0;
  const compareNames = [...baseTables.map((t) => t.name), ...ftsTables.map((t) => t.name)];
  for (const name of compareNames) {
    const src = all(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`)[0].c;
    const resp = await q(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`);
    const dest = extractCount(resp);
    const mark = src === dest ? "OK" : "MISMATCH";
    if (src !== dest) mismatch += 1;
    console.log(`${mark}\t${name}\tsource=${src}\td1=${dest}`);
  }

  db.close();
  if (mismatch) {
    throw new Error(`${mismatch} table count(s) did not match; D1 hydration incomplete`);
  }
  console.log("Hydration verified: all compared table counts match.");
}


function extractRows(resp) {
  const result = resp.result ?? resp;
  const first = Array.isArray(result) ? result[0] : result;
  const rows = first?.results ?? first?.rows ?? [];
  return Array.isArray(rows) ? rows : [];
}

function extractCount(resp) {
  const result = resp.result ?? resp;
  const first = Array.isArray(result) ? result[0] : result;
  const rows = first?.results ?? first?.rows ?? [];
  const row = rows[0];
  if (!row) return undefined;
  return row.c ?? row["COUNT(*)"] ?? Object.values(row)[0];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
