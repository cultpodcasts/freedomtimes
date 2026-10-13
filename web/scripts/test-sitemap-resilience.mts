import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	SITEMAP_RETRY_AFTER_SECONDS,
	isKnownSitemapPath,
	serveSitemapResiliently,
	type SitemapCache,
} from '../src/lib/sitemap-resilience.ts';

const ORIGIN = 'https://freedomtimes.news';
const XML = '<?xml version="1.0"?>\n<urlset>\n  <url><loc>https://freedomtimes.news/posts/a</loc></url>\n</urlset>';

function memoryCache(): SitemapCache & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		match: async (key) => (store.has(key) ? new Response(store.get(key)) : undefined),
		put: async (key, res) => {
			store.set(key, await res.text());
		},
	};
}

async function flush(pending: Promise<unknown>[]) {
	await Promise.all(pending);
}

describe('sitemap resilience', () => {
	it('recognises only the sitemap index and posts sitemaps', () => {
		assert.ok(isKnownSitemapPath('/sitemap.xml'));
		assert.ok(isKnownSitemapPath('/sitemap-posts.xml'));
		assert.ok(isKnownSitemapPath('/sitemap-posts-2.xml'));
		assert.ok(!isKnownSitemapPath('/sitemap-unknown.xml'));
		assert.ok(!isKnownSitemapPath('/posts/sitemap.xml'));
	});

	it('generates, injects the hub into sitemap-posts, and caches', async () => {
		const cache = memoryCache();
		const pending: Promise<unknown>[] = [];
		const res = await serveSitemapResiliently({
			origin: ORIGIN,
			pathname: '/sitemap-posts.xml',
			generate: async () => new Response(XML, { status: 200 }),
			cache,
			hubPath: '/weekly-summaries',
			waitUntil: (p) => pending.push(p),
		});
		await flush(pending);
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.match(body, /<loc>https:\/\/freedomtimes\.news\/weekly-summaries<\/loc>/);
		assert.equal(cache.store.size, 2);
	});

	it('serves the fresh cache without regenerating', async () => {
		const cache = memoryCache();
		const pending: Promise<unknown>[] = [];
		await serveSitemapResiliently({ origin: ORIGIN, pathname: '/sitemap.xml', generate: async () => new Response(XML), cache, waitUntil: (p) => pending.push(p) });
		await flush(pending);
		let called = false;
		const res = await serveSitemapResiliently({
			origin: ORIGIN,
			pathname: '/sitemap.xml',
			generate: async () => { called = true; return new Response('x'); },
			cache,
		});
		assert.equal(called, false);
		assert.equal(res.headers.get('X-FT-Sitemap'), 'cache');
	});

	it('never returns 404: serves last-known-good on a 404 generation', async () => {
		const cache = memoryCache();
		cache.store.set(`${ORIGIN}/__ft-sitemap-cache/stale/sitemap-posts.xml`, XML);
		const res = await serveSitemapResiliently({
			origin: ORIGIN,
			pathname: '/sitemap-posts.xml',
			generate: async () => new Response('<!-- Collection not found or empty -->', { status: 404 }),
			cache,
		});
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('X-FT-Sitemap'), 'stale');
	});

	it('returns 503 + Retry-After when generation fails or throws and nothing is cached', async () => {
		for (const generate of [
			async () => new Response('nope', { status: 404 }),
			async () => new Response('err', { status: 500 }),
			async () => { throw new Error('db down'); },
		]) {
			const res = await serveSitemapResiliently({ origin: ORIGIN, pathname: '/sitemap-posts.xml', generate, cache: memoryCache() });
			assert.equal(res.status, 503);
			assert.equal(res.headers.get('Retry-After'), String(SITEMAP_RETRY_AFTER_SECONDS));
		}
		const noCache = await serveSitemapResiliently({ origin: ORIGIN, pathname: '/sitemap.xml', generate: async () => new Response('', { status: 404 }), cache: null });
		assert.equal(noCache.status, 503);
	});

	it('locked site: anonymous request never gets a cached body; downstream auth response passes through', async () => {
		const cache = memoryCache();
		cache.store.set(`${ORIGIN}/__ft-sitemap-cache/fresh/sitemap-posts.xml`, XML);
		cache.store.set(`${ORIGIN}/__ft-sitemap-cache/stale/sitemap-posts.xml`, XML);
		const res = await serveSitemapResiliently({
			origin: ORIGIN,
			pathname: '/sitemap-posts.xml',
			locked: true,
			generate: async () => new Response(null, { status: 302, headers: { Location: '/login-wall', 'Cache-Control': 'public, max-age=900' } }),
			cache,
		});
		assert.equal(res.status, 302);
		assert.equal(res.headers.get('Location'), '/login-wall');
		assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
		assert.equal(await res.text(), '');
	});

	it('locked site: never writes the cache', async () => {
		const cache = memoryCache();
		const res = await serveSitemapResiliently({
			origin: ORIGIN,
			pathname: '/sitemap.xml',
			locked: true,
			generate: async () => new Response(XML, { status: 200 }),
			cache,
		});
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
		assert.equal(cache.store.size, 0);
	});

	it('HEAD returns status and headers without a body', async () => {
		const res = await serveSitemapResiliently({
			origin: ORIGIN,
			pathname: '/sitemap-posts.xml',
			head: true,
			generate: async () => new Response(XML, { status: 200 }),
			cache: null,
		});
		assert.equal(res.status, 200);
		assert.match(res.headers.get('Content-Type') ?? '', /xml/);
		assert.equal(await res.text(), '');
	});

	it('installed EmDash sitemap query still excludes noindexed rows', async () => {
		const { readFileSync, readdirSync } = await import('node:fs');
		const dir = new URL('../node_modules/emdash/dist/', import.meta.url);
		const hits = readdirSync(dir)
			.filter((f) => f.startsWith('seo-') && f.endsWith('.mjs'))
			.map((f) => readFileSync(new URL(f, dir), 'utf8'))
			.filter((src) => src.includes('seo_no_index'));
		assert.ok(hits.length > 0, 'emdash sitemap source not found');
		assert.ok(hits.some((src) => /s\.seo_no_index IS NULL OR s\.seo_no_index = 0/.test(src)), 'noindex filter missing from EmDash sitemap query; strip noindexed URLs in sitemap-resilience');
	});
});
