/**
 * Worker integration test for the error routes (PR #119): runs the BUILT Worker with the deploy
 * config (`wrangler.jsonc --env production|staging`, incl. its `assets.binding`, PR #118) in
 * `wrangler dev` (local workerd and local bindings) and checks real HTTP responses.
 *
 *   npm run build                      # or: npx astro build && npx tsx scripts/patch-cloudflare-bundle.ts
 *   npm run test:worker-routes
 *
 * Always runs (database unreachable, TURSO_DATABASE_URL → a closed local port):
 *   - unknown multi-segment URLs → 404, NotFoundView, noindex, no canonical
 *   - `/<slug>` and `/posts/<slug>` → 5xx, NOT 404 (an outage must never look like "gone");
 *     `/posts/<slug>` and `/` render src/pages/500.astro (#123: `/` used to stream a cut-off 200)
 *   - with PAGE_CACHE=on: `/` stays a 5xx on repeat requests, never `x-ft-cache: HIT` (#123)
 * With FT_TEST_LIBSQL_URL (a LOCAL libsql / `turso dev` URL, migrated with `npx emdash migrate`):
 *   - `/` → 200, unknown slug / unknown multi-segment → 404, locked staging → 302 to sign-in
 *   - with PAGE_CACHE=on: `/` → MISS then HIT with the same complete page; `/?x=1` → BYPASS-query
 *   - FT_TEST_POST_SLUG / FT_TEST_PAGE_SLUG (optional): a published post / page that must render 200
 *     at `/posts/<slug>` and `/<slug>` (also through `[slug]` for the post)
 * Never point FT_TEST_LIBSQL_URL at staging or production: the Worker may write (auto-seed).
 *
 * Not part of `npm test` / the build: it needs a fresh dist/, wrangler and ~30 s per Worker.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const config = 'wrangler.jsonc';
const built = 'dist/server/entry.mjs';
const UNREACHABLE_DB = 'http://127.0.0.1:9';
const localDb = process.env.FT_TEST_LIBSQL_URL?.trim() || '';
const postSlug = process.env.FT_TEST_POST_SLUG?.trim() || '';
const pageSlug = process.env.FT_TEST_PAGE_SLUG?.trim() || '';

if (localDb && !/^(https?|libsql|ws):\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(localDb)) {
	throw new Error('FT_TEST_LIBSQL_URL must be a local URL (127.0.0.1 / localhost)');
}

/** Unknown multi-segment URLs that were 500 / error 1101 on production on 27 Oct 2026. */
const UNKNOWN = ['/2026/10/11/', '/category/nope', '/tag/x', '/a/b/c', '/posts/x/y', '/archives/a/b', '/_emdash/nope/x', '/.well-known/x/y'];

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as { port: number };
			srv.close(() => resolve(port));
		});
	});
}

type Worker = { base: string; proc: ChildProcess; log: string[] };

async function startWorker(env: 'production' | 'staging', vars: Record<string, string>): Promise<Worker> {
	const port = await freePort();
	const args = ['wrangler', 'dev', '-c', config, '--env', env, '--ip', '127.0.0.1', '--port', String(port), '--log-level', 'warn'];
	for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
	const proc = spawn('npx', args, { cwd: webRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
	const log: string[] = [];
	proc.stdout?.on('data', (d) => log.push(String(d)));
	proc.stderr?.on('data', (d) => log.push(String(d)));
	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null) throw new Error(`wrangler dev exited ${proc.exitCode}:\n${log.join('').slice(-2000)}`);
		try {
			await fetch(`${base}/robots.txt`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
			return { base, proc, log };
		} catch {
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	stopWorker({ base, proc, log });
	throw new Error(`wrangler dev did not start:\n${log.join('').slice(-2000)}`);
}

function stopWorker(w: Worker | undefined) {
	if (w?.proc.pid) {
		try {
			process.kill(-w.proc.pid, 'SIGTERM');
		} catch {
			/* already gone */
		}
	}
}

async function get(w: Worker, path: string) {
	const res = await fetch(`${w.base}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
	return { status: res.status, headers: res.headers, body: await res.text() };
}

function assertNotFoundPage(r: { status: number; body: string }, path: string) {
	assert.equal(r.status, 404, `${path}: status`);
	assert.match(r.body, /data-ft-not-found/, `${path}: standard NotFoundView`);
	assert.match(r.body, /<meta name="robots" content="noindex,nofollow"/, `${path}: noindex`);
	assert.doesNotMatch(r.body, /rel="canonical"/, `${path}: no canonical on a 404`);
}

function assertServerErrorPage(r: { status: number; headers: Headers; body: string }, path: string) {
	assert.equal(r.status, 500, `${path}: status`);
	assert.equal(r.headers.get('cache-control'), 'no-store', `${path}: no-store`);
	assert.match(r.body, /data-ft-server-error/, `${path}: src/pages/500.astro`);
	assert.match(r.body, /<meta name="robots" content="noindex,nofollow"/, `${path}: noindex`);
	assert.doesNotMatch(r.body, /rel="canonical"/, `${path}: no canonical on a 500`);
	assert.doesNotMatch(r.body, /data-ft-not-found/, `${path}: never the 404 page`);
}

describe('error routes in the built Worker', { skip: !existsSync(`${webRoot}${built}`) && `no ${built}: run npm run build first` }, () => {
	describe('database unreachable (public)', () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'off', TURSO_DATABASE_URL: UNREACHABLE_DB, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		for (const path of UNKNOWN) {
			it(`${path} → 404 page`, async () => assertNotFoundPage(await get(w!, path), path));
		}
		for (const path of ['/posts/some-real-looking-post', '/some-real-looking-page']) {
			it(`${path} → 5xx, never 404 (outage is not "gone")`, async () => {
				const r = await get(w!, path);
				assert.ok(r.status >= 500 && r.status < 600, `${path}: got ${r.status}`);
				assert.doesNotMatch(r.body, /data-ft-not-found/);
			});
		}
		it('/ → 500 page (no-store, noindex), never a cut-off 200 or the 404 page (#123)', async () => {
			const r = await get(w!, '/');
			assertServerErrorPage(r, '/');
		});
		it('500.astro: server errors render the 500 page (no-store, noindex, no canonical)', async () => {
			assertServerErrorPage(await get(w!, '/posts/some-real-looking-post'), '/posts/some-real-looking-post');
		});
	});

	describe('database unreachable, PAGE_CACHE on (production cache config)', () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'on', TURSO_DATABASE_URL: UNREACHABLE_DB, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		it('/ → 5xx on every request, never stored or served from the page cache (#123)', async () => {
			for (let i = 0; i < 3; i += 1) {
				const r = await get(w!, '/');
				assertServerErrorPage(r, `/ (request ${i + 1})`);
				assert.notEqual(r.headers.get('x-ft-cache'), 'HIT', `/ (request ${i + 1}): served from cache`);
				assert.notEqual(r.headers.get('x-ft-cache'), 'MISS', `/ (request ${i + 1}): a 5xx was offered to the cache`);
			}
		});
	});

	describe('local database reachable (public)', { skip: !localDb && 'set FT_TEST_LIBSQL_URL to a local migrated libsql URL' }, () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'off', TURSO_DATABASE_URL: localDb, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		it('/ → 200 (real pages unchanged)', async () => {
			const r = await get(w!, '/');
			assert.equal(r.status, 200);
			assert.doesNotMatch(r.body, /data-ft-not-found/);
		});
		it('direct GET /404 → 404 page, /500 → 500 page (static error routes outrank [slug], #120)', async () => {
			assertNotFoundPage(await get(w!, '/404'), '/404');
			const r = await get(w!, '/500');
			assert.equal(r.status, 500);
			assert.match(r.body, /data-ft-server-error/);
		});
		it('/no-such-page-xyz → 404 page', async () => assertNotFoundPage(await get(w!, '/no-such-page-xyz'), '/no-such-page-xyz'));
		it('/posts/does-not-exist-xyz → 404 page', async () => assertNotFoundPage(await get(w!, '/posts/does-not-exist-xyz'), '/posts/does-not-exist-xyz'));
		for (const path of UNKNOWN) {
			it(`${path} → 404 page`, async () => assertNotFoundPage(await get(w!, path), path));
		}
		for (const [label, path, skip] of [
			['a published post', `/posts/${postSlug}`, !postSlug && 'set FT_TEST_POST_SLUG'],
			['a published post via [slug]', `/${postSlug}`, !postSlug && 'set FT_TEST_POST_SLUG'],
			['a published page', `/${pageSlug}`, !pageSlug && 'set FT_TEST_PAGE_SLUG'],
		] as const) {
			it(`${label} → 200`, { skip }, async () => {
				const r = await get(w!, path);
				assert.equal(r.status, 200, `${path}: got ${r.status}`);
				assert.doesNotMatch(r.body, /data-ft-not-found/);
				assert.match(r.body, /rel="canonical"/, `${path}: real pages keep their canonical`);
			});
		}
	});

	describe('local database reachable, PAGE_CACHE on (production cache config)', { skip: !localDb && 'set FT_TEST_LIBSQL_URL to a local migrated libsql URL' }, () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'on', TURSO_DATABASE_URL: localDb, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		it('/ → MISS then HIT with the same complete page', async () => {
			const miss = await get(w!, '/');
			assert.equal(miss.status, 200);
			assert.equal(miss.headers.get('x-ft-cache'), 'MISS');
			assert.match(miss.body, /<\/html>\s*$/i, 'complete document');
			let hit = await get(w!, '/');
			// cache.put runs in waitUntil after the MISS response; allow it a moment to land.
			for (let i = 0; i < 10 && hit.headers.get('x-ft-cache') !== 'HIT'; i += 1) {
				await new Promise((r) => setTimeout(r, 500));
				hit = await get(w!, '/');
			}
			assert.equal(hit.status, 200);
			assert.equal(hit.headers.get('x-ft-cache'), 'HIT');
			assert.equal(hit.body, miss.body);
		});
		it('/?x=1 → BYPASS-query (query strings never use the cache)', async () => {
			const r = await get(w!, '/?x=1');
			assert.equal(r.status, 200);
			assert.equal(r.headers.get('x-ft-cache'), 'BYPASS-query');
		});
	});

	describe('local database reachable (locked staging)', { skip: !localDb && 'set FT_TEST_LIBSQL_URL to a local migrated libsql URL' }, () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('staging', { SITE_ACCESS_MODE: 'locked', PAGE_CACHE: 'off', TURSO_DATABASE_URL: localDb, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		for (const path of ['/a/b', '/2026/10/11/', '/no-such-page-xyz', '/posts/does-not-exist-xyz']) {
			it(`${path} → 302 to sign-in (the 404 page is not public on locked staging)`, async () => {
				const r = await get(w!, path);
				assert.equal(r.status, 302, `${path}: got ${r.status}`);
				assert.doesNotMatch(r.body, /data-ft-not-found/);
			});
		}
	});
});
