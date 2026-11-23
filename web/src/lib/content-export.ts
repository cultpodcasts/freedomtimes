/**
 * Admin SQLite export of the EmDash content database (PR #198).
 *
 * Produces a standard SQLite SQL dump (the `sqlite3 .dump` shape: schema, then rows, then indexes,
 * then FTS5 rows, then triggers and views) from ANY SQLite-compatible backend through one
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
	if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
	if (value instanceof Uint8Array) return `X'${toHex(value)}'`;
	if (value instanceof ArrayBuffer) return `X'${toHex(new Uint8Array(value))}'`;
	if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
		// D1 returns BLOB columns as arrays of byte values.
		return `X'${toHex(Uint8Array.from(value as number[]))}'`;
	}
	return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
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
	return { tables, ftsTables, indexes, triggers, views };
}

function withoutRowid(sql: string | null): boolean {
	return /WITHOUT\s+ROWID/i.test(sql ?? '');
}

async function* dumpRows(
	query: ContentExportQuery,
	table: SqliteMasterEntry,
	counts: Map<string, number>,
	pageSize: number,
): AsyncGenerator<string> {
	const order = withoutRowid(table.sql) ? '' : ' ORDER BY rowid';
	let offset = 0;
	let total = 0;
	for (;;) {
		const rows = await query(`SELECT * FROM ${quoteIdent(table.name)}${order} LIMIT ${pageSize} OFFSET ${offset}`);
		if (rows.length === 0) break;
		let chunk = '';
		for (const row of rows) {
			const columns = Object.keys(row);
			chunk += `INSERT INTO ${quoteIdent(table.name)}(${columns.map(quoteIdent).join(',')}) VALUES(${columns
				.map((c) => sqlLiteral(row[c]))
				.join(',')});\n`;
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
		'-- restore: node web/scripts/sqlite-from-content-export.mjs <this file> <out.db>   (or: sqlite3 out.db < this.sql)',
		'-- PRIVATE: contains unpublished drafts and account data. Never commit, upload or share publicly.',
		'PRAGMA foreign_keys=OFF;',
		'BEGIN TRANSACTION;',
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
	yield `COMMIT;\n-- rows exported per table:\n${summary}\n-- end of export\n`;
}

/** Which deployed environment this Worker is, from the request host (the export names its file by it). */
export function resolveDeployEnvironmentName(hostname: string): 'production' | 'staging' | 'local' {
	const host = hostname.trim().toLowerCase();
	if (host === 'freedomtimes.news' || host === 'www.freedomtimes.news') return 'production';
	if (host === 'staging.freedomtimes.news') return 'staging';
	return 'local';
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