/**
 * Unknown URLs must return the site's 404 page (HTTP 404), never a 400/500 or a redirect.
 *
 * Before src/pages/404.astro existed, a URL that no route matches (`/2026/10/11/`,
 * `/category/x`, `/posts/a/b`) fell back to `[slug].astro` with no `slug` param, which
 * answered HTTP 400 "Missing slug" in plain text (observed in a local Worker with the
 * ASSETS binding present; on the live Workers the unbound ASSETS made it a 500 first,
 * fixed separately in wrangler.jsonc). Single-segment misses answered plain-text 404.
 * Now both render the standard NotFoundView with status 404.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

describe('unknown URLs → 404 page (not 500)', () => {
	it('src/pages/404.astro is a server-rendered 404 with the standard view, no redirect', () => {
		const page = read('src/pages/404.astro');
		assert.match(page, /export const prerender = false;/);
		assert.match(page, /Astro\.response\.status = 404;/);
		assert.match(page, /<NotFoundView \/>/);
		assert.doesNotMatch(page, /Astro\.redirect|Astro\.rewrite|Response\.redirect/);
		const view = read('src/components/NotFoundView.astro');
		assert.match(view, /<Layout [^>]*noindex/);
	});

	it('[slug].astro renders the 404 view with status 404 (no plain-text 404 / 400)', () => {
		const page = read('src/pages/[slug].astro');
		assert.doesNotMatch(page, /'Page not found', \{ status: 404 \}/);
		assert.doesNotMatch(page, /'Missing slug'/);
		assert.match(page, /<NotFoundView \/>/);
		assert.equal((page.match(/Astro\.response\.status = 404;/g) ?? []).length, 2);
		// A genuine lookup failure (DB down) is still a 500, not a fake 404.
		assert.match(page, /'Unable to load page right now', \{ status: 500 \}/);
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

	it('/404 is not a cacheable reader page and 404 responses are never stored', () => {
		assert.equal(isCacheablePath('/404'), false);
		assert.equal(
			decidePageCacheRequest(
				{ PAGE_CACHE: 'on', SITE_ACCESS_MODE: 'public' },
				{ method: 'GET', pathname: '/no-such-page', search: '', cookie: null, authorization: null },
			).cacheable,
			true,
			'single-segment misses do go through the cache handler…',
		);
		assert.equal(
			isStorableResponse({ status: 404, headers: new Headers({ 'content-type': 'text/html' }) }),
			false,
			'…but a 404 is never stored',
		);
	});
});
