/**
 * PR #198: admin SQLite export round trip. Builds a SQLite DB shaped like EmDash's (FTS5 with its own
 * content, sync trigger, index, quotes, NULLs, BLOBs, a WITHOUT ROWID table, D1/libsql internal
 * tables), dumps it through src/lib/content-export.ts, restores with
 * scripts/sqlite-from-content-export.mjs and compares every row.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
	contentDumpToStream,
	contentExportFileName,
	generateContentDump,
	planContentExport,
	sqlLiteral,
	type ContentExportRow,
} from '../src/lib/content-export.ts';
import { resolveDeployEnvironmentName } from '../src/lib/deploy-environment.ts';
import { readContentExport, restoreContentExport } from './sqlite-from-content-export.mjs';

const meta = { environment: 'staging', backend: 'd1', generatedAt: new Date('2026-11-23T12:05:01.123Z') };

function sourceDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		CREATE TABLE ec_posts (id TEXT PRIMARY KEY, title TEXT, body TEXT, views INTEGER, score REAL, cover BLOB, status TEXT);
		CREATE INDEX idx_posts_status ON ec_posts(status);
		CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
		CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
		CREATE VIRTUAL TABLE ec_posts_fts USING fts5(id UNINDEXED, title, body);
		CREATE TRIGGER posts_ai AFTER INSERT ON ec_posts BEGIN
			INSERT INTO ec_posts_fts(id, title, body) VALUES (new.id, new.title, new.body);
		END;
		CREATE VIEW published AS SELECT id, title FROM ec_posts WHERE status = 'published';
	`);
	const insert = db.prepare('INSERT INTO ec_posts VALUES (?, ?, ?, ?, ?, ?, ?)');
	insert.run('p1', "Survivors' truths", 'line one\nline two; -- not a comment', 42, 1.5, new Uint8Array([0, 1, 254, 255]), 'published');
	insert.run('p2', null, 'x'.repeat(150_000), null, null, null, 'draft');
	for (let i = 3; i <= 12; i += 1) insert.run(`p${i}`, `Post ${i}`, `Body ${i}`, i, i / 2, null, 'published');
	db.prepare('INSERT INTO kv VALUES (?, ?)').run('site', '{"name":"freedom times"}');
	db.prepare('INSERT INTO _cf_KV VALUES (?, ?)').run('internal', new Uint8Array([1]));
	return db;
}

const queryFor = (db: DatabaseSync) => async (sql: string) => db.prepare(sql).all() as ContentExportRow[];

async function dumpText(db: DatabaseSync, pageSize = 4): Promise<{ text: string; counts: Map<string, number> }> {
	const counts = new Map<string, number>();
	let text = '';
	for await (const chunk of generateContentDump(queryFor(db), meta, { pageSize, counts })) text += chunk;
	return { text, counts };
}

const rows = (db: DatabaseSync, sql: string) => JSON.stringify(db.prepare(sql).all());

describe('sqlLiteral', () => {
	it('quotes like sqlite3 .dump', () => {
		assert.equal(sqlLiteral(null), 'NULL');
		assert.equal(sqlLiteral(3), '3');
		assert.equal(sqlLiteral(Number.NaN), 'NULL');
		assert.equal(sqlLiteral(10n), '10');
		assert.equal(sqlLiteral("it's"), "'it''s'");
		assert.equal(sqlLiteral(new Uint8Array([0, 255])), "X'00ff'");
		assert.equal(sqlLiteral([1, 2]), "X'0102'", 'D1 returns BLOBs as byte arrays');
	});
});

describe('planContentExport', () => {
	it('skips internal and FTS shadow tables and keeps dump order', async () => {
		const db = sourceDb();
		const master = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all() as never;
		const plan = planContentExport(master);
		assert.deepEqual(plan.tables.map((t) => t.name), ['ec_posts', 'kv']);
		assert.deepEqual(plan.ftsTables.map((t) => t.name), ['ec_posts_fts']);
		assert.deepEqual(plan.indexes.map((t) => t.name), ['idx_posts_status']);
		assert.deepEqual(plan.triggers.map((t) => t.name), ['posts_ai']);
		assert.deepEqual(plan.views.map((t) => t.name), ['published']);
	});
});

describe('generateContentDump round trip', () => {
	it('restores every row, FTS row, index, trigger and view exactly once', async () => {
		const src = sourceDb();
		const { text, counts } = await dumpText(src);
		assert.match(text, /^-- Freedom Times EmDash content export/);
		assert.match(text, /-- environment: staging\n-- backend: d1/);
		assert.ok(text.trimEnd().endsWith('-- end of export'));
		assert.doesNotMatch(text, /_cf_KV/, 'D1 internals are never exported');
		assert.equal(counts.get('ec_posts'), 12);
		assert.equal(counts.get('ec_posts_fts'), 12);

		const dir = mkdtempSync(join(tmpdir(), 'ft-export-'));
		try {
			const file = join(dir, 'x.sql.gz');
			writeFileSync(file, gzipSync(text));
			const restoredCounts = restoreContentExport(readContentExport(file), join(dir, 'out.db')) as Record<string, number>;
			assert.equal(restoredCounts.ec_posts, 12);
			assert.equal(restoredCounts.ec_posts_fts, 12, 'trigger created after rows: no duplicate FTS rows');
			const out = new DatabaseSync(join(dir, 'out.db'));
			try {
				assert.equal(rows(out, 'SELECT * FROM ec_posts ORDER BY id'), rows(src, 'SELECT * FROM ec_posts ORDER BY id'));
				assert.equal(rows(out, 'SELECT * FROM kv'), rows(src, 'SELECT * FROM kv'));
				assert.equal(rows(out, "SELECT id FROM ec_posts_fts WHERE ec_posts_fts MATCH 'truths'"), '[{"id":"p1"}]');
				assert.equal(rows(out, 'SELECT * FROM published ORDER BY id'), rows(src, 'SELECT * FROM published ORDER BY id'));
				out.exec("INSERT INTO ec_posts(id, title, body, status) VALUES ('p13', 'new', 'b', 'draft')");
				assert.equal(rows(out, "SELECT id FROM ec_posts_fts WHERE id = 'p13'"), '[{"id":"p13"}]', 'trigger restored');
				assert.equal(rows(out, "SELECT name FROM sqlite_master WHERE name = 'idx_posts_status'"), '[{"name":"idx_posts_status"}]');
			} finally {
				out.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('the restore script refuses a truncated download', () => {
		const dir = mkdtempSync(join(tmpdir(), 'ft-export-'));
		try {
			const file = join(dir, 'cut.sql');
			writeFileSync(file, '-- Freedom Times EmDash content export\nBEGIN TRANSACTION;\nCREATE TABLE t(a);\n');
			assert.throws(() => readContentExport(file), /incomplete/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('streams gzip that decompresses to the same dump', async () => {
		const src = sourceDb();
		const { text } = await dumpText(src);
		const gz = Buffer.from(await new Response(contentDumpToStream(generateContentDump(queryFor(src), meta, { pageSize: 4 }), true)).arrayBuffer());
		assert.equal(gz[0], 0x1f);
		const dir = mkdtempSync(join(tmpdir(), 'ft-export-'));
		try {
			writeFileSync(join(dir, 'y.sql.gz'), gz);
			assert.equal(readContentExport(join(dir, 'y.sql.gz')), text);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('naming and environment', () => {
	it('names the file by env, backend and UTC time', () => {
		assert.equal(contentExportFileName(meta, true), 'freedomtimes-staging-content-d1-20261123T120501Z.sql.gz');
		assert.equal(contentExportFileName(meta, false), 'freedomtimes-staging-content-d1-20261123T120501Z.sql');
	});
	it('maps hosts to environments', () => {
		assert.equal(resolveDeployEnvironmentName('freedomtimes.news'), 'production');
		assert.equal(resolveDeployEnvironmentName('staging.freedomtimes.news'), 'staging');
		assert.equal(resolveDeployEnvironmentName('localhost'), 'local');
	});
});

describe('admin gate (source checks)', () => {
	const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
	it('the download route is admin-only and never cached', () => {
		const route = read('../src/pages/api/admin/content-export.ts');
		assert.match(route, /authorizeAdminApiRequest\(\{[\s\S]*roleCheck: hasAdminRole/);
		assert.ok(route.indexOf('authorizeAdminApiRequest(') < route.indexOf('createContentExportQuery()'), 'auth before any DB read');
		assert.match(route, /'cache-control': 'no-store, private'/);
	});
	it('the admin page is admin-only', () => {
		const page = read('../src/pages/admin/content-export.astro');
		assert.match(page, /requireAdminPageSession\(\{[\s\S]*roleCheck: hasAdminRole/);
	});
});