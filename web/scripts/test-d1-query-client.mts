/** PR #198: direct content lookups use D1 `EMDASH` on the D1 backend (synthetic fake binding). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createD1ContentQueryClient, isD1Like, type D1Like } from '../src/lib/content/d1-query-client.ts';

function fakeD1(rows: unknown[] | undefined) {
	const calls: { sql: string; args: unknown[] }[] = [];
	const d1: D1Like = {
		prepare(sql) {
			return {
				bind(...args) {
					return {
						async all() {
							calls.push({ sql, args });
							return { results: rows };
						},
					};
				},
			};
		},
	};
	return { d1, calls };
}

describe('createD1ContentQueryClient', () => {
	it('binds args in order and returns named rows like libsql', async () => {
		const { d1, calls } = fakeD1([{ alt: 'A hero', id: 'm1' }]);
		const res = await createD1ContentQueryClient(d1).execute({ sql: 'SELECT alt FROM media WHERE id = ? AND x = ?', args: ['m1', 'y'] });
		assert.deepEqual(calls, [{ sql: 'SELECT alt FROM media WHERE id = ? AND x = ?', args: ['m1', 'y'] }]);
		assert.equal((res.rows[0] as { alt: string }).alt, 'A hero');
	});
	it('missing results → empty rows', async () => {
		assert.deepEqual((await createD1ContentQueryClient(fakeD1(undefined).d1).execute({ sql: 'x', args: [] })).rows, []);
	});
	it('isD1Like', () => {
		assert.equal(isD1Like(fakeD1([]).d1), true);
		assert.equal(isD1Like(undefined), false);
		assert.equal(isD1Like({}), false);
	});
	it('contentEntry picks D1 EMDASH before any Turso URL when FT_CONTENT_BACKEND=d1', () => {
		const src = readFileSync(fileURLToPath(new URL('../src/lib/content/contentEntry.ts', import.meta.url)), 'utf8');
		const fn = src.slice(src.indexOf('function createLibsqlClientForContentQueries'));
		assert.ok(fn.indexOf("=== 'd1'") > 0 && fn.indexOf("=== 'd1'") < fn.indexOf("'TURSO_DATABASE_URL'"));
		assert.match(fn, /createD1ContentQueryClient\(d1\)/);
	});
});