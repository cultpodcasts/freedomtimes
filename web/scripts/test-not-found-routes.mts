/**
 * Unknown URLs must return the site's 404 page (HTTP 404, noindex), never a 400/500 or a
 * redirect, and real failures must stay 5xx (never a fake 404 that would de-index a live URL).
 *
 * Before src/pages/404.astro / 500.astro existed, Astro rendered its error routes by matching
 * `/404` and `/500` against the route table, which hit `[slug].astro` with no `slug` param:
 * HTTP 400 "Missing slug" in plain text (observed in a local Worker with the ASSETS binding from
 * PR #118; on the live Workers the unbound ASSETS made unmatched URLs a 500 / error 1101 first).
 *
 * The decisions are pure functions in src/lib/not-found.ts (tested here). The rendered Worker
 * responses are covered by `npm run test:worker-routes` (scripts/test-error-routes-worker.mts),
 * which needs a built dist/ and wrangler, so it is not part of `npm test`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decideEntryLookup, decideSlugParam, isExpectedLookupMiss } from '../src/lib/not-found.ts';
import { decidePageCacheRequest, isCacheablePath, isStorableResponse } from '../src/lib/page-cache-policy.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(webRoot, rel), 'utf8');

/** File-system routes under src/pages as regexes (Astro: `[x]` = one segment, `[...x]` = rest). */
function pageRoutes(): { file: string; re: RegExp }[] {
	const pagesDir = join(webRoot, 'src/pages');
	const out: { file: string; re: RegExp }[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(astro|ts|js)$/.test(name)) continue;
			const rel = relative(pagesDir, full).replace(/\\/g, '/');
			let route = rel.replace(/\.(astro|ts|js)$/, '').replace(/(^|\/)index$/, '');
			const segs = route.split('/').filter(Boolean).map((seg) => {
				if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return '.*';
				return seg
					.split(/(\[[^\]]+\])/)
					.map((part) => (/^\[[^\]]+\]$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
					.join('');
			});
			out.push({ file: rel, re: new RegExp(`^/${segs.join('/')}/?$`) });
		}
	};
	walk(pagesDir);
	return out;
}

const matching = (pathname: string) => pageRoutes().filter((r) => r.re.test(pathname)).map((r) => r.file);

describe('src/lib/not-found.ts', () => {
	it('decideSlugParam: a slug is looked up; an empty slug (error render) is a server error, not 404', () => {
		assert.deepEqual(decideSlugParam('about'), { kind: 'lookup', slug: 'about' });
		assert.deepEqual(decideSlugParam(undefined), { kind: 'server-error' });
		assert.deepEqual(decideSlugParam(''), { kind: 'server-error' });
	});

	/** Astro's typed miss (`astro/dist/content/loaders/errors.js`), as `getLiveEntry` returns it. */
	function liveEntryNotFound(lookup: string): Error {
		const error = new Error(`Entry emdash → ${lookup} was not found.`);
		error.name = 'LiveEntryNotFoundError';
		return error;
	}

	/** EmDash 1.3.1's loader wraps every database / runtime failure like this (never a typed miss). */
	const loaderFailure = (message: string) => new Error(`Failed to load entry: ${message}`);

	/** Transient failures whose message HAPPENS to read like a miss (#121): must stay 5xx. */
	const MISS_LIKE_FAILURES = [
		loaderFailure('Server returned HTTP status 404: Not Found'),
		loaderFailure('SQLITE_ERROR: no such column: missing_col'),
		loaderFailure('Hrana stream not found (expired), please retry'),
		loaderFailure('no rows returned: connection reset by peer'),
		loaderFailure('relation "ec_posts" does not exist'),
		new Error('Entry not found'),
		new Error('Missing entry'),
		new Error('SQLITE_ERROR: no such table: ec_pages'),
		new Error('Unknown collection: pages'),
		Object.assign(new Error('Unexpected error loading entry emdash → x'), { name: 'LiveCollectionError' }),
	];

	it('isExpectedLookupMiss: only the typed LiveEntryNotFoundError is a miss, never message text (#121)', () => {
		assert.equal(isExpectedLookupMiss(liveEntryNotFound('posts/x')), true);
		assert.equal(isExpectedLookupMiss({ name: 'LiveEntryNotFoundError' }), true, 'name check like LiveEntryNotFoundError.is()');
		for (const error of MISS_LIKE_FAILURES) {
			assert.equal(isExpectedLookupMiss(error), false, `${error.name}: ${error.message}`);
		}
		for (const value of ['Entry not found', 'missing', null, undefined, 404, { message: 'not found' }]) {
			assert.equal(isExpectedLookupMiss(value), false, `non-Error value ${JSON.stringify(value)}`);
		}
		for (const message of ['fetch failed', 'Hrana: connection reset', 'SERVER_ERROR: 503', 'Network connection lost', 'timeout']) {
			assert.equal(isExpectedLookupMiss(new Error(message)), false, message);
		}
	});

	it('decideEntryLookup: clean misses → not-found (404)', () => {
		assert.deepEqual(decideEntryLookup([{ entry: null }, { entry: null }]), { kind: 'not-found' });
		assert.deepEqual(decideEntryLookup([{ entry: undefined }, { entry: null }]), { kind: 'not-found' });
		assert.deepEqual(decideEntryLookup([{ entry: null, error: liveEntryNotFound('pages/x') }, { entry: null }]), { kind: 'not-found' });
		assert.deepEqual(decideEntryLookup([]), { kind: 'not-found' });
	});

	it('decideEntryLookup: a transient error that READS like a miss → server-error (500), never 404 (#121)', () => {
		for (const error of MISS_LIKE_FAILURES) {
			assert.deepEqual(
				decideEntryLookup([{ entry: null, error }, { entry: null }]),
				{ kind: 'server-error', message: error.message, error },
				error.message,
			);
			assert.equal(decideEntryLookup([{ entry: null }, { entry: null, error }]).kind, 'server-error', `second collection: ${error.message}`);
		}
	});

	it('posts/[slug] and archives/[slug]: every non-miss error is rethrown (500.astro, or 503 if the store is down), not a 404', () => {
		for (const file of ['src/pages/posts/[slug].astro', 'src/pages/archives/[slug].astro']) {
			assert.match(
				read(file),
				/if \(!isExpectedLookupMiss\(result\.error\)\) \{\s*(\/\/[^\n]*\n\s*)*await rethrowLookupFailure\(result\.error, assertContentStoreReady\);/,
				file,
			);
		}
		for (const file of ['src/pages/[slug].astro', 'src/pages/posts/[slug].astro', 'src/pages/archives/[slug].astro', 'src/lib/not-found.ts']) {
			assert.doesNotMatch(read(file), /\.toLowerCase\(\)\.includes\(|message\.includes\(/, `${file}: no message-text classification (#121)`);
		}
	});

	it('decideEntryLookup: any unexpected failure with no entry → server-error (500), never 404', () => {
		const fetchFailed = new Error('fetch failed');
		assert.deepEqual(
			decideEntryLookup([{ entry: null, error: fetchFailed }, { entry: null }]),
			{ kind: 'server-error', message: 'fetch failed', error: fetchFailed },
		);
		const reset = new Error('Hrana: connection reset');
		assert.deepEqual(
			decideEntryLookup([{ entry: null }, { entry: null, error: reset }]),
			{ kind: 'server-error', message: 'Hrana: connection reset', error: reset },
		);
	});

	it('decideEntryLookup: server-error carries the FIRST unexpected error (the one [slug] rethrows)', () => {
		const first = new Error('fetch failed');
		const outcome = decideEntryLookup([
			{ entry: null, error: liveEntryNotFound('pages/x') },
			{ entry: null, error: first },
			{ entry: null, error: new Error('SERVER_ERROR: 503') },
		]);
		assert.equal(outcome.kind, 'server-error');
		assert.equal(outcome.kind === 'server-error' && outcome.error, first);
	});

	it('[slug].astro: a lookup server-error rethrows (500.astro); only the empty-slug branch is plain text', () => {
		const page = read('src/pages/[slug].astro');
		assert.match(page, /if \(outcome\.kind === 'server-error'\) \{[\s\S]*?await rethrowLookupFailure\(outcome\.error, assertContentStoreReady\);[\s\S]*?\}/);
		assert.equal([...page.matchAll(/Unable to load page right now/g)].length, 1, 'plain-text 500 only on the decideSlugParam error-render path');
	});

	it('decideEntryLookup: an entry wins (first collection that has it)', () => {
		assert.deepEqual(decideEntryLookup([{ entry: { id: 1 } }, { entry: null }]), { kind: 'found', index: 0 });
		assert.deepEqual(decideEntryLookup([{ entry: null, error: new Error('fetch failed') }, { entry: { id: 2 } }]), { kind: 'found', index: 1 });
	});
});

describe('error routes', () => {
	it('/404 and /500 resolve to src/pages/404.astro / 500.astro (static routes outrank [slug])', () => {
		// Astro ranks a static segment above a dynamic one, so with both files present it renders
		// 404.astro / 500.astro for its error routes instead of falling through to [slug].astro.
		assert.ok(matching('/404').includes('404.astro'), matching('/404').join(', '));
		assert.ok(matching('/500').includes('500.astro'), matching('/500').join(', '));
	});

	it('404.astro: status 404, staging lock gate, standard view, no redirect', () => {
		const page = read('src/pages/404.astro');
		assert.match(page, /export const prerender = false;/);
		assert.match(page, /Astro\.response\.status = 404;/);
		assert.match(page, /if \(isLockedSiteAccess\(\)\) \{[\s\S]*requireEditorialSession\(/);
		assert.match(page, /<NotFoundView \/>/);
		assert.doesNotMatch(page, /Astro\.redirect\(|Astro\.rewrite|Response\.redirect/);
	});

	it('500.astro: 500 + noindex (marked for the 503 + Retry-After, no robots meta for a down content store), no-store, no canonical, no DB / EmDash imports', () => {
		const page = read('src/pages/500.astro');
		assert.match(page, /export const prerender = false;/);
		// Astro pins 500.astro to 500; src/middleware.ts promotes the marked variant to 503.
		assert.match(page, /Astro\.response\.status = 500;/);
		assert.match(page, /Cache-Control', 'no-store'/);
		assert.match(page, /if \(storeUnavailable\) \{\s*Astro\.response\.headers\.set\('Retry-After', String\(CONTENT_STORE_RETRY_AFTER_SECONDS\)\);\s*Astro\.response\.headers\.set\(CONTENT_STORE_UNAVAILABLE_HEADER, '1'\);/);
		assert.match(page, /<Layout\s[^>]*canonicalUrl=\{null\}[^>]*noindex=\{!storeUnavailable\}[^>]*omitRobotsMeta=\{storeUnavailable\}/);
		const imports = [...page.matchAll(/^import [^;]*? from '([^']+)';$/gm)].map((m) => m[1]);
		assert.deepEqual(imports, ['../layouts/Layout.astro', '../lib/content-store-guard']);
		// The guard module 500.astro imports is pure: no EmDash, database or session imports.
		const guardImports = [...read('src/lib/content-store-guard.ts').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
		assert.deepEqual(guardImports, ['./not-found']);
		const notFoundImports = [...read('src/lib/not-found.ts').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
		assert.deepEqual(notFoundImports, []);
		const layoutImports = [...read('src/layouts/Layout.astro').matchAll(/^import .*'([^']+)';$/gm)].map((m) => m[1]);
		assert.ok(layoutImports.every((i) => !/emdash|editorial-session|auth/.test(i)), layoutImports.join(', '));
	});

	it('NotFoundView: noindex, no canonical / og:url, no CMS link; used by every reader 404', () => {
		const view = read('src/components/NotFoundView.astro');
		assert.match(view, /<Layout [^>]*canonicalUrl=\{null\}[^>]*noindex/);
		assert.doesNotMatch(view, /_emdash/);
		const layout = read('src/layouts/Layout.astro');
		assert.match(layout, /\{absoluteCanonical && <link rel="canonical"/);
		assert.match(layout, /\{absoluteCanonical && <meta property="og:url"/);
		for (const file of ['src/pages/[slug].astro', 'src/pages/posts/[slug].astro', 'src/pages/archives/[slug].astro']) {
			const page = read(file);
			assert.match(page, /<NotFoundView[ \/]/, file);
			assert.doesNotMatch(page, /_emdash\/admin/, `${file}: no CMS link on a public 404`);
			assert.doesNotMatch(page, /lower\.includes\('not found'\)/, `${file}: use isExpectedLookupMiss from src/lib/not-found`);
		}
	});

	it('there is no catch-all route that would swallow unknown multi-segment URLs', () => {
		const catchAll = pageRoutes().filter((r) => r.re.source.includes('.*'));
		assert.deepEqual(catchAll.map((r) => r.file), []);
	});

	// URLs that returned 500 (error 1101) on production on 27 Oct 2026, and 400 "Missing slug" once
	// ASSETS is bound: no route matches them, so Astro now renders src/pages/404.astro.
	for (const pathname of [
		'/2026/10/11/',
		'/2026/13/40',
		'/category/nope',
		'/tag/x',
		'/author/x',
		'/page/999',
		'/a/b',
		'/a/b/c',
		'/posts/x/y',
		'/archives/a/b',
		'/admin/nope',
		'/api/nope',
		'/auth/nope',
		'/_emdash/nope/x',
		'/.well-known/x/y',
	]) {
		it(`${pathname} matches no route (→ 404.astro)`, () => {
			assert.deepEqual(matching(pathname), []);
			assert.equal(isCacheablePath(pathname), false);
		});
	}

	// Single-segment and /posts/<slug> misses are handled by their own route's not-found branch.
	for (const [pathname, file] of [
		['/no-such-page', '[slug].astro'],
		['/2026', '[slug].astro'],
		['/posts/does-not-exist-xyz', 'posts/[slug].astro'],
		['/archives/nope', 'archives/[slug].astro'],
	] as const) {
		it(`${pathname} → ${file}`, () => {
			assert.ok(matching(pathname).includes(file), `${pathname} should match ${file}: ${matching(pathname).join(', ')}`);
		});
	}

	it('/404 and /500 are not cacheable reader pages and 404 / 500 responses are never stored', () => {
		assert.equal(isCacheablePath('/404'), false);
		assert.equal(isCacheablePath('/500'), false);
		assert.equal(
			decidePageCacheRequest(
				{ PAGE_CACHE: 'on', SITE_ACCESS_MODE: 'public' },
				{ method: 'GET', pathname: '/no-such-page', search: '', cookie: null, authorization: null },
			).cacheable,
			true,
			'single-segment misses do go through the cache handler…',
		);
		for (const status of [404, 500]) {
			assert.equal(
				isStorableResponse({ status, headers: new Headers({ 'content-type': 'text/html' }) }),
				false,
				`…but a ${status} is never stored`,
			);
		}
	});
});
