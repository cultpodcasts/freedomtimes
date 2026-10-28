import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	CACHEABLE_STATIC_ROUTES,
	DENY_TOP_LEVEL,
	PAGE_CACHE_DEFAULT_TTL_SECONDS,
	decidePageCacheRequest,
	hasOnlyNonSessionCookies,
	isCacheablePath,
	isCompleteStorableBody,
	isPageCacheEnabled,
	isStorableResponse,
	pageCacheKeyUrl,
	pageCacheTtlSeconds,
} from '../src/lib/page-cache-policy.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PROD = { PAGE_CACHE: 'on', PAGE_CACHE_TTL_SECONDS: '120', SITE_ACCESS_MODE: 'public' };
const req = (over: Partial<Parameters<typeof decidePageCacheRequest>[1]> = {}) => ({
	method: 'GET',
	pathname: '/',
	search: '',
	cookie: null,
	authorization: null,
	...over,
});

describe('page cache: enablement (staging safety)', () => {
	it('is on only with PAGE_CACHE=on AND public site access', () => {
		assert.equal(isPageCacheEnabled(PROD), true);
		assert.equal(isPageCacheEnabled({ ...PROD, PAGE_CACHE: 'off' }), false);
		assert.equal(isPageCacheEnabled({ ...PROD, PAGE_CACHE: undefined }), false);
		assert.equal(isPageCacheEnabled({ ...PROD, SITE_ACCESS_MODE: 'locked' }), false);
		assert.equal(isPageCacheEnabled({ ...PROD, SITE_ACCESS_MODE: undefined }), false);
	});

	it('locked staging never caches even if the flag were flipped on', () => {
		const d = decidePageCacheRequest({ PAGE_CACHE: 'on', SITE_ACCESS_MODE: 'locked' }, req());
		assert.deepEqual(d, { cacheable: false, reason: 'disabled' });
	});

	it('wrangler.jsonc: production on, staging off and locked', () => {
		const wrangler = read('../wrangler.jsonc');
		const staging = wrangler.slice(wrangler.indexOf('"staging"'));
		const production = wrangler.slice(wrangler.indexOf('"production"'), wrangler.indexOf('"staging"'));
		assert.match(production, /"PAGE_CACHE":\s*"on"/);
		assert.match(staging, /"PAGE_CACHE":\s*"off"/);
		assert.match(staging, /"SITE_ACCESS_MODE":\s*"locked"/);
		assert.match(production, /"placement":\s*\{\s*"region":\s*"aws:eu-west-1"\s*\}/);
		assert.match(staging, /"placement":\s*\{\s*"region":\s*"aws:eu-west-1"\s*\}/);
	});

	it('TTL defaults to 120 s and is capped', () => {
		assert.equal(pageCacheTtlSeconds({}), PAGE_CACHE_DEFAULT_TTL_SECONDS);
		assert.equal(pageCacheTtlSeconds({ PAGE_CACHE_TTL_SECONDS: '60' }), 60);
		assert.equal(pageCacheTtlSeconds({ PAGE_CACHE_TTL_SECONDS: 'abc' }), 120);
		assert.equal(pageCacheTtlSeconds({ PAGE_CACHE_TTL_SECONDS: '99999' }), 600);
	});
});

describe('page cache: request bypass rules', () => {
	it('caches reader pages', () => {
		for (const p of [
			'/',
			'/posts/weekly-summary-11-october-2026',
			'/contact-us',
			'/robots.txt',
			'/archives',
			'/archives/2026',
		]) {
			assert.equal(isCacheablePath(p), true, p);
		}
	});

	it('never caches admin, EmDash, API, auth, preview or utility routes', () => {
		for (const p of [
			'/_emdash',
			'/_emdash/admin',
			'/_emdash/api/mcp',
			'/admin/analytics',
			'/api/version.json',
			'/auth/login',
			'/authorize',
			'/.well-known/assetlinks.json',
			'/homepage',
			'/login-wall',
			'/signed-in',
			'/submit-a-tip',
			'/tip-source',
			'/manifest.webmanifest',
			'/sitemap.xml',
			'/sitemap-posts.xml',
			'/preview',
			'/cdn-cgi/trace',
			'/posts/draft-electoral-matters-hearing-transcript-2026-10-16)',
			'/posts/x/y',
			'/posts/Upper',
			'/posts/a%20b',
		]) {
			assert.equal(isCacheablePath(p), false, p);
		}
	});

	it('bypasses on ANY session/auth/unknown cookie; tolerates CF/GA cookies', () => {
		assert.equal(hasOnlyNonSessionCookies(null), true);
		assert.equal(hasOnlyNonSessionCookies('__cf_bm=x; _ga=1; _ga_ABC123=2; cf_clearance=y'), true);
		for (const c of ['astro-session=abc', 'ft_session=x', 'appSession=x', 'auth0.is.authenticated=true', 'theme=dark', '__cf_bm=x; emdash_session=y']) {
			assert.equal(hasOnlyNonSessionCookies(c), false, c);
		}
		assert.deepEqual(decidePageCacheRequest(PROD, req({ cookie: 'astro-session=abc' })), {
			cacheable: false,
			reason: 'cookie',
		});
	});

	it('bypasses Authorization and non-GET/HEAD', () => {
		assert.equal(decidePageCacheRequest(PROD, req({ authorization: 'Bearer x' })).cacheable, false);
		assert.equal(decidePageCacheRequest(PROD, req({ method: 'POST' })).cacheable, false);
		assert.equal(decidePageCacheRequest(PROD, req({ method: 'HEAD' })).cacheable, true);
	});

	it('fails closed on ANY query string, including tracking params (no poisoning via utm_*)', () => {
		// Layout.astro canonical/og:url fallback and Header.astro `next=` render the query.
		for (const s of ['?preview=1', '?_preview=tok', '?edit=1', '?page=2', '?token=x', '?utm_source=x', '?fbclid=y', '?gclid=z&utm_medium=a', '?ref=x']) {
			assert.deepEqual(decidePageCacheRequest(PROD, req({ pathname: '/archives', search: s })), { cacheable: false, reason: 'query' }, s);
		}
		assert.deepEqual(decidePageCacheRequest(PROD, req({ pathname: '/archives', search: '' })), { cacheable: true, keyPath: '/archives' });
	});
});

describe('page cache: route classification (catch-all fails closed)', () => {
	it('every top-level src/pages entry is explicitly denied or allow-listed', () => {
		const pagesDir = fileURLToPath(new URL('../src/pages/', import.meta.url));
		const names = readdirSync(pagesDir)
			.filter((n) => n !== '[slug].astro')
			.map((n) => n.replace(/\.(astro|ts|js|mts|md|mdx)$/, ''));
		assert.ok(names.length > 5, 'expected to enumerate src/pages');
		for (const name of names) {
			if (name.startsWith('.') || name.startsWith('_')) {
				// Rejected by isCacheablePath's `/.` and `/_` prefix check.
				assert.equal(isCacheablePath(`/${name}/x`), false, name);
				continue;
			}
			assert.ok(
				DENY_TOP_LEVEL.has(name) || CACHEABLE_STATIC_ROUTES.has(name),
				`New top-level route src/pages/${name}: add it to DENY_TOP_LEVEL (not a cacheable reader page) or CACHEABLE_STATIC_ROUTES in src/lib/page-cache-policy.ts`,
			);
			assert.ok(!(DENY_TOP_LEVEL.has(name) && CACHEABLE_STATIC_ROUTES.has(name)), `${name} is in both lists`);
		}
	});

	it('denied top-level segments are never cacheable, even as a single-segment slug', () => {
		for (const name of DENY_TOP_LEVEL) {
			assert.equal(isCacheablePath(`/${name}`), false, name);
		}
		assert.equal(isCacheablePath('/pages/about'), false);
	});
});

describe('page cache: response storability', () => {
	const ok = (h: Record<string, string>, status = 200) => ({ status, headers: new Headers(h) });
	const html = { 'content-type': 'text/html; charset=utf-8' };

	it('stores plain 200 HTML and text', () => {
		assert.equal(isStorableResponse(ok(html)), true);
		assert.equal(isStorableResponse(ok({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' })), true);
	});

	it('never stores non-200, Set-Cookie, private/no-store, Vary: Cookie, or non-HTML', () => {
		for (const status of [301, 302, 304, 404, 410, 500, 503]) {
			assert.equal(isStorableResponse(ok(html, status)), false, String(status));
		}
		assert.equal(isStorableResponse(ok({ ...html, 'set-cookie': 'a=b' })), false);
		assert.equal(isStorableResponse(ok({ ...html, 'cache-control': 'private' })), false);
		assert.equal(isStorableResponse(ok({ ...html, 'cache-control': 'no-store' })), false);
		assert.equal(isStorableResponse(ok({ ...html, 'cache-control': 'no-cache' })), false);
		assert.equal(isStorableResponse(ok({ ...html, vary: 'Cookie' })), false);
		assert.equal(isStorableResponse(ok({ 'content-type': 'application/json' })), false);
		assert.equal(isStorableResponse(ok({})), false);
	});

	it('cache key carries the purge epoch and is not a routable path', () => {
		const key = pageCacheKeyUrl('https://freedomtimes.news', 'mabc', '/posts/x');
		assert.equal(key, 'https://freedomtimes.news/__ft_page_cache/mabc/posts/x');
		assert.equal(isCacheablePath(new URL(key).pathname), false);
	});
});

describe('page cache: body completeness before store (#123)', () => {
	const enc = (text: string) => new TextEncoder().encode(text);
	const html = 'text/html; charset=utf-8';

	it('a full HTML document is complete (trailing whitespace allowed, any case)', () => {
		assert.equal(isCompleteStorableBody(html, enc('<!DOCTYPE html><html><body>x</body></html>')), true);
		assert.equal(isCompleteStorableBody(html, enc('<!DOCTYPE html><html><body>x</body></HTML>\n\n')), true);
		assert.equal(isCompleteStorableBody(html, enc(`<html><body>${'x'.repeat(200_000)}</body></html>`)), true);
	});

	it('empty or cut-off HTML is never complete', () => {
		assert.equal(isCompleteStorableBody(html, new Uint8Array(0)), false);
		assert.equal(isCompleteStorableBody(html, enc('<!DOCTYPE html><html><head><title>x</title></head><body>')), false);
		assert.equal(isCompleteStorableBody(html, enc('<html><body></html><p>trailing junk</p>')), false);
		assert.equal(isCompleteStorableBody(null, new Uint8Array(0)), false);
	});

	it('plain text only has to be non-empty', () => {
		assert.equal(isCompleteStorableBody('text/plain', enc('User-agent: *\n')), true);
		assert.equal(isCompleteStorableBody('text/plain', new Uint8Array(0)), false);
	});
});

describe('page cache: wiring', () => {
	const outer = read('../src/emdash-outer-middleware.ts');
	const astroConfig = read('../astro.config.ts');
	const plugin = read('../src/plugins/page-cache-purge.ts');
	const handler = read('../src/lib/page-cache-handler.ts');

	it('outer middleware wires the cache handler before EmDash runtime, no db access', () => {
		assert.match(outer, /handlePageCache\(pageCacheDeps\(\)/);
		assert.match(outer, /hasPendingCookies: \(\) => !context\.cookies\.headers\(\)\.next\(\)\.done/);
		assert.match(outer, /recordPageView,/);
		for (const src of [outer, handler]) {
			assert.doesNotMatch(src, /getDb\(/);
			assert.doesNotMatch(src, /from 'emdash\/runtime'/);
		}
		assert.doesNotMatch(handler, /from 'cloudflare:workers'/);
	});

	it('purge plugin is registered and hooks content changes', () => {
		assert.match(astroConfig, /id: 'ft-page-cache-purge'/);
		assert.match(astroConfig, /page-cache-purge\.ts/);
		for (const hook of ['afterSave', 'afterPublish', 'afterUnpublish', 'afterDelete', 'afterRestore']) {
			assert.match(plugin, new RegExp(`'content:${hook}'`), hook);
		}
		assert.match(plugin, /capabilities: \['content:read'\]/);
		assert.match(plugin, /createPurgeHooks\(/);
		assert.match(plugin, /isPageCacheEnabled/);
	});

	it('does not touch robots or add noindex', () => {
		assert.doesNotMatch(outer, /noindex|robots/i);
		assert.doesNotMatch(plugin, /noindex|robots/i);
	});
});
