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
 *   - `/<slug>`, `/posts/<slug>` and `/` → 503 + Retry-After, src/pages/500.astro with no robots
 *     meta (#128: the content store is down; an outage must never look like "gone"). Before #128
 *     these were the 500 page (#123: `/` used to stream a cut-off 200, `/<slug>` used to answer an
 *     unstyled plain-text 500)
 *   - with PAGE_CACHE=on: `/` stays a 5xx on repeat requests, never `x-ft-cache: HIT` (#123)
 *   - `/sitemap-site-pages.xml` (#34) → 503 + Retry-After, never 404
 * Always runs (database answers HTTP 404 "Not Found" with a body saying "missing", like the wrong
 * libsql host of July 2026, from a local stub server):
 *   - `/<slug>`, `/posts/<slug>` and `/archives/<slug>` → 503 page, NEVER the noindex 404 page,
 *     although the error message reads like a miss (#121: only a typed not-found is a 404; #128:
 *     the content-store probe fails too, so it is a 503)
 * With FT_TEST_LIBSQL_URL (a LOCAL libsql / `turso dev` URL, migrated with `npx emdash migrate`):
 *   - `/` → 200, unknown slug / unknown multi-segment → 404, locked staging → 302 to sign-in
 *   - with PAGE_CACHE=on: `/` → MISS then HIT with the same complete page; `/?x=1` → BYPASS-query
 *   - sitemaps (#34): `/sitemap.xml` lists `/sitemap-site-pages.xml`, which lists `/` (+ pages and
 *     archives present in the database); every listed URL answers 200 with a matching canonical.
 *     Locked staging: `/sitemap-site-pages.xml` is EmDash's 404 and `/sitemap.xml` does not list it
 *   - FT_TEST_ARCHIVE_SLUG (optional): a published archive that must be listed in the site sitemap
 *   - FT_TEST_POST_SLUG / FT_TEST_PAGE_SLUG (optional): a published post / page that must render 200
 *     at `/posts/<slug>` and `/<slug>` (also through `[slug]` for the post), end at `</html>` (no
 *     script after it), pass `isCompleteStorableBody`, and with PAGE_CACHE=on go MISS then HIT
 *   - FT_TEST_ARCHIVE_SLUG (optional): a published archive issue that must render 200 at both
 *     `/archives/<slug>` and `/archives/<id>` (EmDash's loader matches slug OR id; the id is read
 *     from the local database's `ec_archives` row)
 *   FT_TEST_LIBSQL_URL needs at least one published post: with none, the content-store guard
 *   (#128) rightly answers 503 for `/` and every miss.
 * With FT_TEST_EMPTY_LIBSQL_URL (a LOCAL libsql URL, migrated with `npx emdash migrate`, no posts;
 * the Worker auto-seeds the empty `ec_*` tables on its first request), #128:
 *   - `/`, `/<slug>`, `/posts/<slug>`, `/archives/<slug>` → 503 page, never a 404 or an empty 200
 *   - `/sitemap-site-pages.xml` → 503, never a thin sitemap; unknown multi-segment URLs stay 404
 * With FT_TEST_UNMIGRATED_LIBSQL_URL (a LOCAL libsql URL with an empty, never-migrated database):
 *   - reader URLs → 503 + Retry-After (EmDash's pending-migrations answer), never 404
 * Never point FT_TEST_LIBSQL_URL, FT_TEST_EMPTY_LIBSQL_URL or FT_TEST_UNMIGRATED_LIBSQL_URL at
 * staging or production: the Worker may write (auto-seed).
 *
 * Not part of `npm test` / the build: it needs a fresh dist/, wrangler and ~30 s per Worker.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';

import { isCompleteStorableBody } from '../src/lib/page-cache-policy.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const config = 'wrangler.jsonc';
const built = 'dist/server/entry.mjs';
const UNREACHABLE_DB = 'http://127.0.0.1:9';
const localDb = process.env.FT_TEST_LIBSQL_URL?.trim() || '';
const emptyDb = process.env.FT_TEST_EMPTY_LIBSQL_URL?.trim() || '';
const unmigratedDb = process.env.FT_TEST_UNMIGRATED_LIBSQL_URL?.trim() || '';
const postSlug = process.env.FT_TEST_POST_SLUG?.trim() || '';
const pageSlug = process.env.FT_TEST_PAGE_SLUG?.trim() || '';
const archiveSlug = process.env.FT_TEST_ARCHIVE_SLUG?.trim() || '';
const SITE_SITEMAP = '/sitemap-site-pages.xml';

for (const [name, url] of [['FT_TEST_LIBSQL_URL', localDb], ['FT_TEST_EMPTY_LIBSQL_URL', emptyDb], ['FT_TEST_UNMIGRATED_LIBSQL_URL', unmigratedDb]]) {
	if (url && !/^(https?|libsql|ws):\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
		throw new Error(`${name} must be a local URL (127.0.0.1 / localhost)`);
	}
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

/** #128: the content store is down / unmigrated / empty → 503 + Retry-After, no robots meta, never 404. */
function assertStoreUnavailablePage(r: { status: number; headers: Headers; body: string }, path: string) {
	assert.equal(r.status, 503, `${path}: status`);
	assert.equal(r.headers.get('retry-after'), '300', `${path}: Retry-After`);
	assert.equal(r.headers.get('cache-control'), 'no-store', `${path}: no-store`);
	assert.match(r.body, /data-ft-server-error/, `${path}: src/pages/500.astro`);
	assert.match(r.body, /data-ft-content-store-unavailable/, `${path}: content-store variant`);
	assert.doesNotMatch(r.body, /<meta name="robots"/, `${path}: no robots meta on a 503`);
	assert.doesNotMatch(r.body, /rel="canonical"/, `${path}: no canonical on a 503`);
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
		it('/posts/some-real-looking-post → 5xx, never 404 (outage is not "gone")', async () => {
			const r = await get(w!, '/posts/some-real-looking-post');
			assert.ok(r.status >= 500 && r.status < 600, `/posts/some-real-looking-post: got ${r.status}`);
			assert.doesNotMatch(r.body, /data-ft-not-found/);
		});
		it('/some-real-looking-page → 503 page via [slug] (store down, #128), never 404 or plain text', async () => {
			assertStoreUnavailablePage(await get(w!, '/some-real-looking-page'), '/some-real-looking-page');
		});
		it('/ → 503 page (store down, #128), never a cut-off 200 or the 404 page (#123)', async () => {
			const r = await get(w!, '/');
			assertStoreUnavailablePage(r, '/');
		});
		it(`${SITE_SITEMAP} → 503 + Retry-After, never 404 (#34)`, async () => {
			const r = await get(w!, SITE_SITEMAP);
			assert.equal(r.status, 503, `${SITE_SITEMAP}: got ${r.status}`);
			assert.equal(r.headers.get('retry-after'), '300');
		});
		it('500.astro: a down content store renders the 503 variant (Retry-After, no-store, no robots meta, no canonical)', async () => {
			assertStoreUnavailablePage(await get(w!, '/posts/some-real-looking-post'), '/posts/some-real-looking-post');
		});
		it('/archives/some-real-looking-issue → 503 page (store down, #128)', async () => {
			assertStoreUnavailablePage(await get(w!, '/archives/some-real-looking-issue'), '/archives/some-real-looking-issue');
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
				assertStoreUnavailablePage(r, `/ (request ${i + 1})`);
				assert.notEqual(r.headers.get('x-ft-cache'), 'HIT', `/ (request ${i + 1}): served from cache`);
				assert.notEqual(r.headers.get('x-ft-cache'), 'MISS', `/ (request ${i + 1}): a 5xx was offered to the cache`);
			}
		});
	});

	describe('database answers 404 "Not Found" / "missing" (public, #121)', () => {
		let w: Worker | undefined;
		let stub: Server | undefined;
		before(async () => {
			const port = await freePort();
			stub = createHttpServer((_req, res) => {
				res.writeHead(404, { 'content-type': 'text/plain' });
				res.end('Not Found: entry missing (no such database)');
			});
			await new Promise<void>((resolve) => stub!.listen(port, '127.0.0.1', resolve));
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'off', TURSO_DATABASE_URL: `http://127.0.0.1:${port}`, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => {
			stopWorker(w);
			stub?.close();
		});

		for (const path of ['/some-real-looking-page', '/posts/some-real-looking-post']) {
			it(`${path} → 503 page, never the noindex 404 (a miss-like message is still an outage)`, async () => {
				assertStoreUnavailablePage(await get(w!, path), path);
			});
		}
		it('/archives/some-real-looking-issue → 503 page (regression guard: archives follows the posts pattern)', async () => {
			assertStoreUnavailablePage(await get(w!, '/archives/some-real-looking-issue'), '/archives/some-real-looking-issue');
		});
		for (const path of ['/a/b/c', '/posts/x/y']) {
			it(`${path} → 404 page (no route matches; unaffected)`, async () => assertNotFoundPage(await get(w!, path), path));
		}
	});

	describe('local database migrated but empty (public, #128)', { skip: !emptyDb && 'set FT_TEST_EMPTY_LIBSQL_URL to a local migrated libsql URL with no posts' }, () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'on', TURSO_DATABASE_URL: emptyDb, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		for (const path of ['/', '/about-us', '/some-real-looking-page', '/posts/some-real-looking-post', '/archives/some-real-looking-issue']) {
			it(`${path} → 503 page on every request, never a 404, an empty 200 or a page-cache HIT`, async () => {
				for (let i = 0; i < 3; i += 1) {
					const r = await get(w!, path);
					assertStoreUnavailablePage(r, `${path} (request ${i + 1})`);
					assert.notEqual(r.headers.get('x-ft-cache'), 'HIT', `${path} (request ${i + 1}): served from cache`);
					assert.notEqual(r.headers.get('x-ft-cache'), 'MISS', `${path} (request ${i + 1}): a 503 was offered to the cache`);
				}
			});
		}
		it(`${SITE_SITEMAP} → 503, never a thin sitemap`, async () => {
			const r = await get(w!, SITE_SITEMAP);
			assert.equal(r.status, 503, `${SITE_SITEMAP}: got ${r.status} ${r.body.slice(0, 200)}`);
		});
		for (const path of ['/a/b/c', '/posts/x/y']) {
			it(`${path} → 404 page (no route matches; unaffected)`, async () => assertNotFoundPage(await get(w!, path), path));
		}
	});

	describe('local database never migrated (public)', { skip: !unmigratedDb && 'set FT_TEST_UNMIGRATED_LIBSQL_URL to a local empty libsql URL' }, () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'off', TURSO_DATABASE_URL: unmigratedDb, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		for (const path of ['/', '/some-real-looking-page', '/posts/some-real-looking-post', '/archives/some-real-looking-issue']) {
			it(`${path} → 503 + Retry-After, never 404`, async () => {
				const r = await get(w!, path);
				assert.equal(r.status, 503, `${path}: got ${r.status}`);
				assert.ok(r.headers.get('retry-after'), `${path}: Retry-After`);
				assert.doesNotMatch(r.body, /data-ft-not-found/);
				assert.doesNotMatch(r.body, /noindex/, `${path}: no noindex on a 503`);
			});
		}
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
			// Not a content-store failure: the plain 500 variant (500, no-store, noindex, no canonical).
			assertServerErrorPage(await get(w!, '/500'), '/500');
		});
		it('/no-such-page-xyz → 404 page', async () => assertNotFoundPage(await get(w!, '/no-such-page-xyz'), '/no-such-page-xyz'));
		it('/posts/does-not-exist-xyz → 404 page', async () => assertNotFoundPage(await get(w!, '/posts/does-not-exist-xyz'), '/posts/does-not-exist-xyz'));
		it('/archives/does-not-exist-xyz → 404 page (typed miss: entry null, no error)', async () =>
			assertNotFoundPage(await get(w!, '/archives/does-not-exist-xyz'), '/archives/does-not-exist-xyz'));
		for (const path of UNKNOWN) {
			it(`${path} → 404 page`, async () => assertNotFoundPage(await get(w!, path), path));
		}
		it(`/sitemap.xml lists ${SITE_SITEMAP} (#34)`, async () => {
			const r = await get(w!, '/sitemap.xml');
			assert.equal(r.status, 200, `/sitemap.xml: got ${r.status}`);
			assert.ok(r.body.includes(`<loc>${w!.base}${SITE_SITEMAP}</loc>`), r.body);
		});
		it(`${SITE_SITEMAP} lists / and every listed URL is a 200 whose canonical is that URL (#34)`, async () => {
			const r = await get(w!, SITE_SITEMAP);
			assert.equal(r.status, 200, `${SITE_SITEMAP}: got ${r.status} ${r.body.slice(0, 300)}`);
			assert.match(r.headers.get('content-type') ?? '', /application\/xml/);
			assert.match(r.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
			const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
			assert.equal(locs[0], `${w!.base}/`);
			if (pageSlug && ['about-us', 'contact-us', 'privacy-policy'].includes(pageSlug)) {
				assert.ok(locs.includes(`${w!.base}/${pageSlug}`), `missing /${pageSlug}`);
			}
			if (archiveSlug) {
				assert.ok(locs.includes(`${w!.base}/archives`), 'missing /archives');
				assert.ok(locs.includes(`${w!.base}/archives/${archiveSlug}`), `missing /archives/${archiveSlug}`);
			}
			for (const loc of locs) {
				const path = loc.slice(w!.base.length);
				const page = await get(w!, path);
				assert.equal(page.status, 200, `${path}: got ${page.status}`);
				const canonical = /<link rel="canonical" href="([^"]+)"/.exec(page.body)?.[1];
				assert.equal(canonical, loc, `${path}: canonical must equal its sitemap <loc>`);
				assert.doesNotMatch(page.body, /<meta name="robots" content="noindex/, `${path}: listed URL must be indexable`);
			}
		});
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
				assert.match(r.body, /<\/html>\s*$/i, `${path}: the document ends at </html> (no script after it)`);
				assert.ok(isCompleteStorableBody(r.headers.get('content-type'), new TextEncoder().encode(r.body)), `${path}: storable body`);
			});
		}
		it('a published archive → 200 at /archives/<slug> and /archives/<id> (loader matches slug or id)', { skip: !archiveSlug && 'set FT_TEST_ARCHIVE_SLUG' }, async () => {
			const db = createClient({ url: localDb.replace(/^libsql:/, 'http:'), authToken: 'local-test' });
			let id: string;
			try {
				const rows = await db.execute({ sql: 'SELECT id FROM ec_archives WHERE slug = ? AND deleted_at IS NULL LIMIT 1', args: [archiveSlug] });
				id = String(rows.rows[0]?.id ?? '');
			} finally {
				db.close();
			}
			assert.ok(id, `FT_TEST_ARCHIVE_SLUG=${archiveSlug}: no ec_archives row in the local database`);
			assert.notEqual(id, archiveSlug, 'the id must differ from the slug, or the id case tests nothing');
			for (const path of [`/archives/${archiveSlug}`, `/archives/${id}`]) {
				const r = await get(w!, path);
				assert.equal(r.status, 200, `${path}: got ${r.status}`);
				assert.doesNotMatch(r.body, /data-ft-not-found/, `${path}: not the 404 page`);
				assert.match(r.body, /<\/html>\s*$/i, `${path}: complete document`);
			}
		});
	});

	describe('local database reachable, PAGE_CACHE on (production cache config)', { skip: !localDb && 'set FT_TEST_LIBSQL_URL to a local migrated libsql URL' }, () => {
		let w: Worker | undefined;
		before(async () => {
			w = await startWorker('production', { SITE_ACCESS_MODE: 'public', PAGE_CACHE: 'on', TURSO_DATABASE_URL: localDb, TURSO_AUTH_TOKEN: 'local-test' });
		});
		after(() => stopWorker(w));

		async function assertMissThenHit(path: string) {
			const miss = await get(w!, path);
			assert.equal(miss.status, 200, `${path}: status`);
			assert.equal(miss.headers.get('x-ft-cache'), 'MISS', `${path}: first request`);
			assert.match(miss.body, /<\/html>\s*$/i, `${path}: complete document`);
			let hit = await get(w!, path);
			// cache.put runs in waitUntil after the MISS response; allow it a moment to land.
			for (let i = 0; i < 10 && hit.headers.get('x-ft-cache') !== 'HIT'; i += 1) {
				await new Promise((r) => setTimeout(r, 500));
				hit = await get(w!, path);
			}
			assert.equal(hit.status, 200, `${path}: status`);
			assert.equal(hit.headers.get('x-ft-cache'), 'HIT', `${path}: served from the page cache`);
			assert.equal(hit.body, miss.body, `${path}: same page`);
		}
		it('/ → MISS then HIT with the same complete page', async () => assertMissThenHit('/'));
		it('a published post → MISS then HIT (article pages are stored)', { skip: !postSlug && 'set FT_TEST_POST_SLUG' }, async () =>
			assertMissThenHit(`/posts/${postSlug}`));
		it('a published page → MISS then HIT (/<page-slug>, e.g. /contact-us, is stored)', { skip: !pageSlug && 'set FT_TEST_PAGE_SLUG' }, async () =>
			assertMissThenHit(`/${pageSlug}`));
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

		it(`${SITE_SITEMAP} → EmDash's 404 and /sitemap.xml does not list it (staging sitemap behaviour unchanged, #34)`, async () => {
			const site = await get(w!, SITE_SITEMAP);
			assert.equal(site.status, 404, `${SITE_SITEMAP}: got ${site.status}`);
			assert.match(site.body, /Sitemap not found/);
			const index = await get(w!, '/sitemap.xml');
			assert.equal(index.headers.get('cache-control'), 'private, no-store');
			assert.doesNotMatch(index.body, /sitemap-site-pages/);
		});
		for (const path of ['/a/b', '/2026/10/11/', '/no-such-page-xyz', '/posts/does-not-exist-xyz']) {
			it(`${path} → 302 to sign-in (the 404 page is not public on locked staging)`, async () => {
				const r = await get(w!, path);
				assert.equal(r.status, 302, `${path}: got ${r.status}`);
				assert.doesNotMatch(r.body, /data-ft-not-found/);
			});
		}
	});
});
