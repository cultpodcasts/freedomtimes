/**
 * Admin SQLite export of the EmDash content database (PR #198).
 *
 * Produces a portable SQLite SQL dump (the `sqlite3 .dump` shape: schema, then rows, then indexes,
 * then FTS5 rows, then triggers and views) that restores unchanged into sqlite3, Turso/libSQL and
 * Cloudflare D1: no BEGIN/COMMIT, no statement over 100 KB, parents before children
 * (scripts/test-content-export-restore.mts restores it into `turso dev` and a local D1) from ANY SQLite-compatible backend through one
 * `query(sql)` function: Cloudflare D1 today, Turso/libsql after swap-back. Each environment's
 * Worker exports its own database (the one EmDash is reading).
 *
 * Restore: `node web/scripts/sqlite-from-content-export.mjs <file.sql.gz> <out.db>` (or
 * `sqlite3 out.db < file.sql`), then `hydrate-d1-from-sqlite.mjs` / Turso import as needed.
 *
 * Why SQL and not a binary .db: building the binary file needs a full in-memory SQLite (wasm) of a
 * 30-45 MB database plus its serialized copy, which does not fit a Worker's 128 MB. The dump is
 * streamed table by table, page by page, so memory stays flat; gzip happens in the stream.
 *
 * Pure: no Worker / EmDash imports, so scripts/test-content-export.mts round-trips it through
 * node:sqlite.
 */

export type ContentExportRow = Record<string, unknown>;
/** Run one read-only SQL statement (no parameters; every identifier here is quoted). */
export type ContentExportQuery = (sql: string) => Promise<ContentExportRow[]>;

export type SqliteMasterEntry = { type: string; name: string; tbl_name: string; sql: string | null };

export type ContentExportMeta = {
	environment: string;
	backend: string;
	generatedAt: Date;
};

export const CONTENT_EXPORT_PAGE_SIZE = 200;

const FTS_SHADOW_SUFFIX = /_(data|idx|content|docsize|config)$/;

export function quoteIdent(name: string): string {
	return `"${String(name).replaceAll('"', '""')}"`;
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/** A value as a SQLite literal (sqlite3 .dump conventions). */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (typeof value === 'string') return stringLiteral(value);
	if (value instanceof Uint8Array) return `X'${toHex(value)}'`;
	if (value instanceof ArrayBuffer) return `X'${toHex(new Uint8Array(value))}'`;
	if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
		// D1 returns BLOB columns as arrays of byte values.
		return `X'${toHex(Uint8Array.from(value as number[]))}'`;
	}
	return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
}

/**
 * `wrangler d1 execute --file` scans the WHOLE file for the text `BEGIN TRANSACTION` and then deletes
 * the first `BEGIN TRANSACTION;` and the first `COMMIT;` it finds, even inside a string literal
 * (workers-utils d1-trimmer). A post that mentions either would be corrupted or rejected on import,
 * so a literal containing them is written as a `||` concatenation that never spells them out.
 */
const WRANGLER_TRIM_TOKENS = /(BEGIN TRANSACTION|COMMIT;)/g;

function stringLiteral(value: string): string {
	const quoted = `'${value.replaceAll("'", "''")}'`;
	if (!value.includes('BEGIN TRANSACTION') && !value.includes('COMMIT;')) return quoted;
	// 'a BEGIN TRANSACTION b' -> 'a BEGIN' || ' TRANSACTION b' (same text, no token in the file).
	return quoted.replace(WRANGLER_TRIM_TOKENS, (token) =>
		token === 'COMMIT;' ? "COMMIT' || ';" : "BEGIN' || ' TRANSACTION",
	);
}

export function isFtsVirtualTable(sql: string | null): boolean {
	return /CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? '') && /USING\s+fts5/i.test(sql ?? '');
}

/** Internal tables that are never exported: SQLite, Cloudflare D1, libsql internals. */
export function isInternalTable(name: string): boolean {
	return /^(sqlite_|_cf_|libsql_|__drizzle)/i.test(name);
}

export type ContentExportPlan = {
	tables: SqliteMasterEntry[];
	ftsTables: SqliteMasterEntry[];
	indexes: SqliteMasterEntry[];
	triggers: SqliteMasterEntry[];
	views: SqliteMasterEntry[];
};

/** Split sqlite_master into what is dumped, in dump order. FTS shadow tables are rebuilt, not copied. */
export function planContentExport(master: SqliteMasterEntry[]): ContentExportPlan {
	const byName = (a: SqliteMasterEntry, b: SqliteMasterEntry) => a.name.localeCompare(b.name);
	const withSql = master.filter((o) => o.sql && o.name && !isInternalTable(o.name));
	const ftsTables = withSql.filter((o) => o.type === 'table' && isFtsVirtualTable(o.sql)).sort(byName);
	const ftsNames = ftsTables.map((t) => t.name);
	const isShadow = (name: string) =>
		ftsNames.some((fts) => name.startsWith(`${fts}_`) && FTS_SHADOW_SUFFIX.test(name.slice(fts.length)));
	const tables = withSql
		.filter((o) => o.type === 'table' && !isFtsVirtualTable(o.sql) && !isShadow(o.name))
		.sort(byName);
	const indexes = withSql
		.filter((o) => o.type === 'index' && !ftsNames.includes(o.tbl_name) && !isShadow(o.tbl_name))
		.sort(byName);
	const triggers = withSql.filter((o) => o.type === 'trigger').sort(byName);
	const views = withSql.filter((o) => o.type === 'view').sort(byName);
	return { tables: parentTablesFirst(tables), ftsTables, indexes, triggers, views };
}

/** Tables named after REFERENCES in a CREATE TABLE statement. */
export function referencedTables(sql: string | null): string[] {
	const out = new Set<string>();
	for (const m of String(sql ?? '').matchAll(/\bREFERENCES\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/gi)) {
		out.add((m[1]?.replaceAll('""', '"') ?? m[2] ?? m[3] ?? m[4]).toLowerCase());
	}
	return [...out];
}

/**
 * Parents before children (stable, alphabetical otherwise). D1 always enforces foreign keys (its
 * `PRAGMA foreign_keys=OFF` is a no-op inside the import transaction), so the dump also sets
 * `PRAGMA defer_foreign_keys=ON`; ordering keeps sqlite3 / turso / D1 happy even without it.
 */
export function parentTablesFirst(tables: SqliteMasterEntry[]): SqliteMasterEntry[] {
	const byLower = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
	const done = new Set<string>();
	const visiting = new Set<string>();
	const out: SqliteMasterEntry[] = [];
	const visit = (t: SqliteMasterEntry) => {
		const key = t.name.toLowerCase();
		if (done.has(key) || visiting.has(key)) return; // cycles: deferred FKs cover them
		visiting.add(key);
		for (const parent of referencedTables(t.sql)) {
			const p = byLower.get(parent);
			if (p && p !== t) visit(p);
		}
		visiting.delete(key);
		done.add(key);
		out.push(t);
	};
	for (const t of tables) visit(t);
	return out;
}

function withoutRowid(sql: string | null): boolean {
	return /WITHOUT\s+ROWID/i.test(sql ?? '');
}

/**
 * Longest statement the dump writes, in UTF-8 bytes. Cloudflare D1 (remote and `wrangler d1 execute
 * --local`) rejects any SQL statement over 100,000 bytes (`statement too long: SQLITE_TOOBIG`); real
 * EmDash rows (revisions, long posts) reach 300 KB. Rows over the cap are written as an INSERT with
 * the long values empty, then `UPDATE ... SET col = col || '<chunk>'` statements under the cap.
 */
export const CONTENT_EXPORT_MAX_STATEMENT_BYTES = 90_000;
/** Raw bytes of one long value per append statement (escaping can at most double it). */
const APPEND_CHUNK_BYTES = 40_000;
/** Values longer than this are moved out of an oversized INSERT into appends. */
const INLINE_VALUE_BYTES = 1_024;

const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).length;

function asBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
		return Uint8Array.from(value as number[]);
	}
	return null;
}

/** Split text into pieces of at most `maxBytes` UTF-8 bytes, never inside a code point. */
export function splitUtf8(text: string, maxBytes: number): string[] {
	const pieces: string[] = [];
	let current = '';
	let size = 0;
	for (const ch of text) {
		const n = ch.length === 1 ? (ch.charCodeAt(0) < 0x80 ? 1 : ch.charCodeAt(0) < 0x800 ? 2 : 3) : 4;
		if (size + n > maxBytes && current) {
			pieces.push(current);
			current = '';
			size = 0;
		}
		current += ch;
		size += n;
	}
	if (current) pieces.push(current);
	return pieces;
}

function insertStatement(table: string, columns: string[], literals: string[]): string {
	return `INSERT INTO ${quoteIdent(table)}(${columns.map(quoteIdent).join(',')}) VALUES(${literals.join(',')});\n`;
}

/**
 * One row as SQL statements, each under CONTENT_EXPORT_MAX_STATEMENT_BYTES. `rowWhere` is the WHERE
 * clause that finds the row just inserted (`rowid = last_insert_rowid()`, or the primary key for a
 * WITHOUT ROWID table).
 */
export async function rowStatements(
	table: string,
	row: ContentExportRow,
	rowWhere: () => Promise<string>,
	maxBytes = CONTENT_EXPORT_MAX_STATEMENT_BYTES,
): Promise<string> {
	const columns = Object.keys(row);
	const literals = columns.map((c) => sqlLiteral(row[c]));
	const whole = insertStatement(table, columns, literals);
	if (byteLength(whole) <= maxBytes) return whole;

	const appends: string[] = [];
	const where = await rowWhere();
	const chunkBytes = Math.min(APPEND_CHUNK_BYTES, Math.floor(maxBytes / 2) - 512);
	columns.forEach((column, i) => {
		if (byteLength(literals[i]) <= INLINE_VALUE_BYTES) return;
		const value = row[column];
		const set = (expr: string) => `UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ${expr} WHERE ${where};\n`;
		const bytes = typeof value === 'string' ? null : asBytes(value);
		if (bytes) {
			literals[i] = "X''";
			for (let at = 0; at < bytes.length; at += chunkBytes) {
				const hex = sqlLiteral(bytes.subarray(at, at + chunkBytes));
				appends.push(set(`CAST(${quoteIdent(column)} || ${hex} AS BLOB)`));
			}
			return;
		}
		const text = typeof value === 'string' ? value : JSON.stringify(value);
		literals[i] = "''";
		for (const piece of splitUtf8(text, chunkBytes)) appends.push(set(`${quoteIdent(column)} || ${sqlLiteral(piece)}`));
	});
	const statements = [insertStatement(table, columns, literals), ...appends];
	for (const statement of statements) {
		if (byteLength(statement) > maxBytes) {
			throw new Error(`content export: a statement for ${table} is still ${byteLength(statement)} bytes after splitting`);
		}
	}
	return statements.join('');
}

async function* dumpRows(
	query: ContentExportQuery,
	table: SqliteMasterEntry,
	counts: Map<string, number>,
	pageSize: number,
): AsyncGenerator<string> {
	const noRowid = withoutRowid(table.sql);
	const order = noRowid ? '' : ' ORDER BY rowid';
	let primaryKey: string[] | null = null;
	let offset = 0;
	let total = 0;
	for (;;) {
		const rows = await query(`SELECT * FROM ${quoteIdent(table.name)}${order} LIMIT ${pageSize} OFFSET ${offset}`);
		if (rows.length === 0) break;
		let chunk = '';
		for (const row of rows) {
			chunk += await rowStatements(table.name, row, async () => {
				if (!noRowid) return 'rowid = last_insert_rowid()';
				primaryKey ??= (
					await query(
						`SELECT name FROM pragma_table_info(${sqlLiteral(table.name)}) WHERE pk > 0 ORDER BY pk`,
					)
				).map((r) => String(r.name));
				if (primaryKey.length === 0) throw new Error(`content export: ${table.name} has no primary key`);
				return primaryKey.map((c) => `${quoteIdent(c)} = ${sqlLiteral(row[c])}`).join(' AND ');
			});
		}
		total += rows.length;
		yield chunk;
		if (rows.length < pageSize) break;
		offset += pageSize;
	}
	counts.set(table.name, total);
}

/**
 * Stream the dump as text chunks. `counts` (optional) receives rows exported per table, for the
 * trailer and the audit log.
 */
export async function* generateContentDump(
	query: ContentExportQuery,
	meta: ContentExportMeta,
	options: { pageSize?: number; counts?: Map<string, number> } = {},
): AsyncGenerator<string> {
	const pageSize = options.pageSize ?? CONTENT_EXPORT_PAGE_SIZE;
	const counts = options.counts ?? new Map<string, number>();
	const master = (await query(
		"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IS NOT NULL ORDER BY type, name",
	)) as unknown as SqliteMasterEntry[];
	const plan = planContentExport(master);

	yield [
		'-- Freedom Times EmDash content export (SQLite SQL dump)',
		`-- environment: ${meta.environment}`,
		`-- backend: ${meta.backend}`,
		`-- generated: ${meta.generatedAt.toISOString()}`,
		'-- format: 2 (portable: sqlite3, Turso/libSQL `turso db shell`, Cloudflare D1 `wrangler d1 execute --file`)',
		'-- restore into a NEW EMPTY database (plain .sql; gunzip first for wrangler):',
		'--   node web/scripts/sqlite-from-content-export.mjs <this file> <out.db>',
		'--   turso db shell <db-or-url> < this.sql   |   wrangler d1 execute <DB> --file this.sql',
		'-- No BEGIN/COMMIT (D1 rejects them; it runs the file in one transaction). With sqlite3/turso a',
		'-- failed restore leaves a partial database: drop it and restore again into a new one.',
		'-- PRIVATE: contains unpublished drafts and account data. Never commit, upload or share publicly.',
		'PRAGMA foreign_keys=OFF;',
		'PRAGMA defer_foreign_keys=ON;',
		'',
	].join('\n');

	for (const table of plan.tables) {
		yield `${table.sql};\n`;
		yield* dumpRows(query, table, counts, pageSize);
	}
	for (const index of plan.indexes) yield `${index.sql};\n`;
	// FTS5 tables here store their own content: recreate, then copy rows (see hydrate-d1-from-sqlite.mjs).
	for (const fts of plan.ftsTables) {
		yield `${fts.sql};\n`;
		yield* dumpRows(query, fts, counts, pageSize);
	}
	// Triggers last so replaying rows never fires them (e.g. FTS sync triggers would duplicate rows).
	for (const view of plan.views) yield `${view.sql};\n`;
	for (const trigger of plan.triggers) yield `${trigger.sql};\n`;

	const summary = [...counts.entries()].map(([name, n]) => `--   ${name}: ${n}`).join('\n');
	yield `-- rows exported per table:\n${summary}\n-- end of export\n`;
}


/** Download file name, e.g. freedomtimes-production-content-d1-20261123T120501Z.sql.gz */
export function contentExportFileName(meta: ContentExportMeta, gzip: boolean): string {
	const stamp = meta.generatedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
	const safe = (s: string) => s.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'unknown';
	return `freedomtimes-${safe(meta.environment)}-content-${safe(meta.backend)}-${stamp}.sql${gzip ? '.gz' : ''}`;
}

/** Text chunks → byte stream, optionally gzip'd (CompressionStream: Workers + Node 18+). */
export function contentDumpToStream(chunks: AsyncGenerator<string>, gzip: boolean): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const text = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await chunks.next();
				if (next.done) controller.close();
				else controller.enqueue(encoder.encode(next.value));
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await chunks.return(undefined);
		},
	});
	return gzip ? text.pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>) : text;
}