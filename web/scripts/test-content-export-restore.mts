/**
 * Integration (PR #198 merge gate): an /admin/content-export dump restores FROM SCRATCH into
 *   - Turso/libSQL: a local `turso dev` server (sqld on 127.0.0.1) via `turso db shell < dump`, and
 *   - Cloudflare D1: a local D1 via `wrangler d1 execute --local --file`,
 * in both forms the admin page offers (.sql and .sql.gz), with identical rows to the source.
 *
 * Local only: never Turso Cloud (empty --config-path, no login, 127.0.0.1 URL), never --remote,
 * no credentials (TURSO_ / CLOUDFLARE_ env vars are stripped). The fixture is synthetic; real
 * dumps are private and are checked with scripts/verify-content-export-restore.mjs instead.
 *
 * A missing turso/sqld or wrangler SKIPS with a WARNING locally; CI sets
 * FT_REQUIRE_RESTORE_TARGETS=1 so a missing tool fails the gate instead of skipping it.
 *
 *   npm run test:content-export-restore
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import {
	CONTENT_EXPORT_MAX_STATEMENT_BYTES,
	contentDumpToStream,
	generateContentDump,
	type ContentExportRow,
} from '../src/lib/content-export';
import {
	compareWithDump,
	createLocalD1,
	digestSqliteFile,
	findTursoTools,
	findWrangler,
	inspectRestored,
	integrityCheckFile,
	parseDumpExpectations,
	restoreIntoTurso,
	startTursoDev,
	tursoQuery,
} from './lib/content-export-restore.mjs';
import { upgradeContentExport } from './upgrade-content-export.mts';

const REQUIRE = process.env.FT_REQUIRE_RESTORE_TARGETS === '1';
const meta = { environment: 'staging', backend: 'd1', generatedAt: new Date('2026-11-23T13:14:59.410Z') };

const tursoTools = findTursoTools();
const wrangler = findWrangler();

function skipReason(target: 'turso' | 'd1'): string | false {
	const missing = target === 'turso' ? tursoTools.missing : wrangler ? [] : ['wrangler (npm ci in web/)'];
	if (missing.length === 0) return false;
	const message = `WARNING: content export restore into ${target === 'turso' ? 'local Turso (turso dev)' : 'local D1'} SKIPPED: ${missing.join(' + ')} not installed. Install with scripts/ci-install-turso-cli.sh --with-sqld (Linux) or the Turso installer.`;
	if (REQUIRE) throw new Error(`${message} FT_REQUIRE_RESTORE_TARGETS=1 makes this a failure.`);
	console.warn(`\x1b[33m${message}\x1b[0m`);
	return message;
}

/** A small EmDash-shaped database that hits every interop edge the real one has (and a few more). */
function buildSource(file: string): void {
	const db = new DatabaseSync(file);
	db.exec(`
		PRAGMA foreign_keys=ON;
		CREATE TABLE "ec_posts" ("id" text primary key, "slug" text, "status" text not null, "title" text, "content" text, "updated_at" text default (datetime('now')));
		CREATE UNIQUE INDEX "uidx_ec_posts_slug" ON "ec_posts" ("slug") WHERE status = 'published';
		CREATE TABLE "revisions" ("id" text primary key, "entry_id" text not null, "data" text not null);
		CREATE INDEX "idx_revisions_entry" ON "revisions" ("entry_id");
		CREATE TABLE "media" ("id" text primary key, "filename" text not null, "mime_type" text, "size" integer, "width" real, "thumb" blob);
		-- child sorts before its parent: D1 always enforces foreign keys
		CREATE TABLE "a_byline_links" ("id" integer primary key, "byline_id" text not null REFERENCES "z_bylines"("id"));
		CREATE TABLE "z_bylines" ("id" text primary key, "name" text);
		CREATE TABLE "options" ("name" text primary key, "value" text) WITHOUT ROWID;
		CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
		CREATE VIRTUAL TABLE "_emdash_fts_posts" USING fts5(
			id UNINDEXED, locale UNINDEXED, title, content,
			tokenize='porter unicode61'
		);
		CREATE VIEW "published_posts" AS SELECT id, title FROM ec_posts WHERE status = 'published';
	`);
	const longBody = `<p>Survivors' accounts — “quotes”, emoji 👩‍👩‍👧 and accents é.</p>\n`.repeat(4_000); // ~300 KB
	const posts: [string, string, string, string, string][] = [
		['p1', 'weekly-1', 'published', "Survivors' truths", longBody],
		['p2', 'weekly-2', 'draft', 'SQL in a post', 'He typed BEGIN TRANSACTION; then COMMIT; then ROLLBACK; -- not a comment'],
		['p3', 'weekly-3', 'published', 'Line breaks', 'one\ntwo\r\nthree; four'],
	];
	for (let i = 4; i <= 40; i += 1) posts.push([`p${i}`, `weekly-${i}`, i % 5 === 0 ? 'draft' : 'published', `Cult news ${i}`, `Body ${i} about the cult`]);
	const insertPost = db.prepare('INSERT INTO ec_posts (id, slug, status, title, content) VALUES (?, ?, ?, ?, ?)');
	const insertFts = db.prepare('INSERT INTO _emdash_fts_posts (id, locale, title, content) VALUES (?, ?, ?, ?)');
	for (const [id, slug, status, title, content] of posts) {
		insertPost.run(id, slug, status, title, content);
		insertFts.run(id, 'en', title, content);
	}
	const insertRev = db.prepare('INSERT INTO revisions (id, entry_id, data) VALUES (?, ?, ?)');
	insertRev.run('r1', 'p1', JSON.stringify({ title: 'big', content: longBody, note: 'BEGIN TRANSACTION' }));
	for (let i = 2; i <= 60; i += 1) insertRev.run(`r${i}`, `p${(i % 40) + 1}`, JSON.stringify({ title: `rev ${i}` }));
	const blob = new Uint8Array(150_000).map((_, i) => (i * 7) % 256); // includes 0x00 bytes
	const insertMedia = db.prepare('INSERT INTO media VALUES (?, ?, ?, ?, ?, ?)');
	insertMedia.run('m1', 'big.png', 'image/png', blob.length, 1200.5, blob);
	for (let i = 2; i <= 90; i += 1) insertMedia.run(`m${i}`, `m${i}.jpg`, 'image/jpeg', i * 1000, null, new Uint8Array([0, i, 255]));
	db.prepare('INSERT INTO z_bylines VALUES (?, ?)').run('b1', 'Freedom Times');
	db.prepare('INSERT INTO a_byline_links (byline_id) VALUES (?)').run('b1');
	db.prepare('INSERT INTO a_byline_links (id, byline_id) VALUES (?, ?)').run(1000, 'b1'); // rowid gap
	db.prepare('INSERT INTO options VALUES (?, ?)').run('site:title', 'Freedom Times');
	db.prepare('INSERT INTO options VALUES (?, ?)').run('site:big', 'x'.repeat(120_000)); // oversized, WITHOUT ROWID
	db.prepare('INSERT INTO _cf_KV VALUES (?, ?)').run('internal', new Uint8Array([1]));
	db.exec(`CREATE TRIGGER "ec_posts_fts_ai" AFTER INSERT ON "ec_posts" BEGIN
		INSERT INTO "_emdash_fts_posts" (id, locale, title, content) VALUES (new.id, 'en', new.title, new.content);
	END;`);
	db.close();
}

const SOURCE_TABLES = ['_emdash_fts_posts', 'a_byline_links', 'ec_posts', 'media', 'options', 'revisions', 'z_bylines'];

let work: string;
let sqlFile: string;
let gzFile: string;
let dumpText: string;
let sourceDigest: Record<string, string>;

before(async () => {
	work = mkdtempSync(join(tmpdir(), 'ft-export-restore-'));
	const source = join(work, 'source.db');
	buildSource(source);
	sourceDigest = digestSqliteFile(source, SOURCE_TABLES);
	const db = new DatabaseSync(source, { readOnly: true });
	const query = async (sql: string) => db.prepare(sql).all() as ContentExportRow[];
	dumpText = '';
	for await (const chunk of generateContentDump(query, meta, { pageSize: 7 })) dumpText += chunk;
	// The .gz exactly as the route streams it (CompressionStream).
	const gz = Buffer.from(await new Response(contentDumpToStream(generateContentDump(query, meta, { pageSize: 7 }), true)).arrayBuffer());
	db.close();
	sqlFile = join(work, 'freedomtimes-staging-content-d1-fixture.sql');
	gzFile = join(work, 'freedomtimes-staging-content-d1-fixture.sql.gz');
	writeFileSync(sqlFile, dumpText);
	writeFileSync(gzFile, gz);
});

after(() => rmSync(work, { recursive: true, force: true }));

describe('portable dump format (static interop checks)', () => {
	it('has no statement over the D1 limit, no BEGIN/COMMIT and no D1 internals', () => {
		const longest = Math.max(...dumpText.split('\n').map((l) => Buffer.byteLength(l)));
		assert.ok(longest <= CONTENT_EXPORT_MAX_STATEMENT_BYTES, `longest statement ${longest} bytes`);
		assert.ok(CONTENT_EXPORT_MAX_STATEMENT_BYTES < 100_000);
		assert.ok(!dumpText.includes('BEGIN TRANSACTION'), 'wrangler would trim/reject the file');
		assert.ok(!dumpText.includes('COMMIT;'), 'wrangler would delete the first COMMIT; even inside a string');
		assert.doesNotMatch(dumpText, /_cf_KV/);
		assert.match(dumpText, /^PRAGMA defer_foreign_keys=ON;$/m);
		assert.ok(dumpText.indexOf('CREATE TABLE "z_bylines"') < dumpText.indexOf('CREATE TABLE "a_byline_links"'), 'parents first');
		assert.match(dumpText, /UPDATE "ec_posts" SET "content" = "content" \|\| '/);
		assert.match(dumpText, /UPDATE "options" SET "value" = "value" \|\| '.*' WHERE "name" = 'site:big';/);
		assert.match(dumpText, /UPDATE "media" SET "thumb" = CAST\("thumb" \|\| X'/);
		const expect = parseDumpExpectations(dumpText);
		assert.equal(expect.complete, true);
		assert.equal(expect.trailer.get('ec_posts'), 40);
		assert.equal(expect.trailer.get('_emdash_fts_posts'), 40);
	});
});

for (const target of ['turso', 'd1'] as const) {
	describe(`restore from scratch into local ${target === 'turso' ? 'Turso (turso dev)' : 'D1 (wrangler --local)'}`, () => {
		for (const form of ['sql', 'sql.gz'] as const) {
			it(`.${form}: tables, row counts, integrity, FTS and every row match the source`, async (t) => {
				const skip = skipReason(target);
				if (skip) return t.skip(skip);
				const file = form === 'sql' ? sqlFile : gzFile;
				const dir = mkdtempSync(join(work, `${target}-${form}-`));
				const expect = parseDumpExpectations(dumpText);
				if (target === 'turso') {
					const server = await startTursoDev({ workDir: dir, tools: tursoTools });
					try {
						assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
						await restoreIntoTurso(server, file);
						await checkRestored((sql) => tursoQuery(server, sql), expect);
					} finally {
						await server.stop();
					}
					assert.equal(integrityCheckFile(server.dbFile), 'ok');
					assert.deepEqual(digestSqliteFile(server.dbFile, SOURCE_TABLES), sourceDigest, 'row-by-row identical to the source');
				} else {
					const d1 = createLocalD1(dir);
					await d1.restore(file);
					await checkRestored((sql) => d1.query(sql), expect);
					assert.equal(integrityCheckFile(d1.sqliteFile()), 'ok');
					assert.deepEqual(digestSqliteFile(d1.sqliteFile(), SOURCE_TABLES), sourceDigest, 'row-by-row identical to the source');
				}
			});
		}
	});
}

async function checkRestored(query: (sql: string) => Promise<Record<string, unknown>[]>, expect: ReturnType<typeof parseDumpExpectations>) {
	const restored = await inspectRestored(query);
	assert.deepEqual(compareWithDump(expect, restored), []);
	assert.deepEqual(restored.tables.sort(), SOURCE_TABLES);
	assert.equal(restored.counts.ec_posts, 40);
	assert.equal(restored.counts.media, 90);
	assert.equal(restored.counts._emdash_fts_posts, 40, 'FTS rows once (trigger created after the rows)');
	assert.equal(restored.integrity, 'ok');
	assert.equal(restored.foreignKeyViolations, 0);
	assert.deepEqual(restored.triggers, ['ec_posts_fts_ai']);
	assert.deepEqual(restored.views, ['published_posts']);
	assert.ok(restored.indexes.includes('uidx_ec_posts_slug') && restored.indexes.includes('idx_revisions_entry'));
	const published = await query("SELECT COUNT(*) AS n FROM ec_posts WHERE status = 'published'");
	assert.equal(Number(published[0].n), 31);
	// porter stemming: "survivor" finds "Survivors'"; the oversized FTS row was rebuilt by appends.
	const hits = await query(`SELECT id FROM "_emdash_fts_posts" WHERE "_emdash_fts_posts" MATCH 'survivor' ORDER BY id`);
	assert.deepEqual(hits.map((r) => r.id), ['p1']);
	const cult = await query(`SELECT COUNT(*) AS n FROM "_emdash_fts_posts" WHERE "_emdash_fts_posts" MATCH 'cult'`);
	assert.equal(Number(cult[0].n), 37);
	const lengths = await query("SELECT length(content) AS n FROM ec_posts WHERE id = 'p1'");
	assert.ok(Number(lengths[0].n) > 250_000);
	const sql = await query("SELECT content FROM ec_posts WHERE id = 'p2'");
	assert.equal(sql[0].content, 'He typed BEGIN TRANSACTION; then COMMIT; then ROLLBACK; -- not a comment');
}

describe('format 1 exports (before the D1 fix)', () => {
	it('upgrade-content-export rewrites one so local D1 accepts it', async (t) => {
		const skip = skipReason('d1');
		if (skip) return t.skip(skip);
		const big = 'y'.repeat(150_000);
		const v1 = [
			'-- Freedom Times EmDash content export (SQLite SQL dump)',
			'-- environment: staging',
			'-- backend: d1',
			'-- generated: 2026-11-23T13:14:59.410Z',
			'PRAGMA foreign_keys=OFF;',
			'BEGIN TRANSACTION;',
			'CREATE TABLE "ec_posts" ("id" text primary key, "content" text);',
			`INSERT INTO "ec_posts"("id","content") VALUES('p1','${big}');`,
			'COMMIT;',
			'-- rows exported per table:',
			'--   ec_posts: 1',
			'-- end of export',
			'',
		].join('\n');
		const dir = mkdtempSync(join(work, 'v1-'));
		const v1File = join(dir, 'v1.sql');
		writeFileSync(v1File, v1);
		await assert.rejects(createLocalD1(join(dir, 'a')).restore(v1File), /statement too long|SQLITE_TOOBIG/);
		const v2File = join(dir, 'v2.sql');
		writeFileSync(v2File, await upgradeContentExport(v1));
		const d1 = createLocalD1(join(dir, 'b'));
		await d1.restore(v2File);
		const rows = await d1.query("SELECT length(content) AS n FROM ec_posts WHERE id = 'p1'");
		assert.equal(Number(rows[0].n), 150_000);
	});
});
