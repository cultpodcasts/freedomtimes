import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
	SITEMAP_PAGE_SLUGS,
	SITE_SITEMAP_PATH,
	buildSiteSitemapUrls,
	renderUrlset,
	toW3CDate,
	type SiteSitemapInput,
} from '../src/lib/site-sitemap.ts';
import { isKnownSitemapPath } from '../src/lib/sitemap-resilience.ts';

const ORIGIN = 'https://freedomtimes.news';

const FULL: SiteSitemapInput = {
	postsUpdatedAt: '2026-10-27T19:43:17.473Z',
	pages: [
		{ slug: 'privacy-policy', updatedAt: '2026-09-01 10:00:00' },
		{ slug: 'about-us', updatedAt: '2026-08-01T09:00:00.000Z' },
		{ slug: 'contact-us', updatedAt: '2026-08-02T09:00:00.000Z', seoCanonical: '' },
		{ slug: 'homepage', updatedAt: '2026-10-01T00:00:00.000Z' },
	],
	archives: [
		{ slug: '2024-07-14-freedom-times', updatedAt: '2026-04-27T21:20:11.560Z' },
		{ slug: '2022-10-01-newcastle-interchange-freedom-times', updatedAt: '2026-05-01T08:00:00.000Z' },
	],
};

describe('site sitemap (#34): /, reader pages and archives', () => {
	it('lists /, the three reader pages, /archives and every archive with canonical production URLs', () => {
		const urls = buildSiteSitemapUrls(ORIGIN, FULL);
		assert.deepEqual(urls, [
			{ loc: 'https://freedomtimes.news/', lastmod: '2026-10-27T19:43:17.473Z' },
			{ loc: 'https://freedomtimes.news/about-us', lastmod: '2026-08-01T09:00:00.000Z' },
			{ loc: 'https://freedomtimes.news/contact-us', lastmod: '2026-08-02T09:00:00.000Z' },
			{ loc: 'https://freedomtimes.news/privacy-policy', lastmod: '2026-09-01T10:00:00.000Z' },
			{ loc: 'https://freedomtimes.news/archives', lastmod: '2026-05-01T08:00:00.000Z' },
			{ loc: 'https://freedomtimes.news/archives/2022-10-01-newcastle-interchange-freedom-times', lastmod: '2026-05-01T08:00:00.000Z' },
			{ loc: 'https://freedomtimes.news/archives/2024-07-14-freedom-times', lastmod: '2026-04-27T21:20:11.560Z' },
		]);
	});

	it('never lists pages outside SITEMAP_PAGE_SLUGS (staging-only /homepage, unknown pages)', () => {
		assert.deepEqual([...SITEMAP_PAGE_SLUGS], ['about-us', 'contact-us', 'privacy-policy']);
		const locs = buildSiteSitemapUrls(ORIGIN, FULL).map((u) => u.loc);
		assert.ok(!locs.some((loc) => /\/homepage$/.test(loc)));
		assert.ok(!locs.some((loc) => loc.includes('/posts/')), 'pages are listed at /<slug>, never /posts/<slug> (a 301)');
	});

	it('leaves out pages and archives the database did not return (drafts, unpublished, deleted, noindex)', () => {
		const urls = buildSiteSitemapUrls(ORIGIN, { postsUpdatedAt: null, pages: [{ slug: 'about-us', updatedAt: null }], archives: [] });
		assert.deepEqual(urls, [{ loc: 'https://freedomtimes.news/' }, { loc: 'https://freedomtimes.news/about-us' }]);
	});

	it('omits /archives when there are no indexable archives', () => {
		const locs = buildSiteSitemapUrls(ORIGIN, { ...FULL, archives: [] }).map((u) => u.loc);
		assert.ok(!locs.includes('https://freedomtimes.news/archives'));
	});

	it('leaves out rows whose SEO canonical points at another URL; keeps self-canonical overrides', () => {
		const urls = buildSiteSitemapUrls(ORIGIN, {
			postsUpdatedAt: null,
			pages: [
				{ slug: 'about-us', updatedAt: null, seoCanonical: '/contact-us' },
				{ slug: 'contact-us', updatedAt: null, seoCanonical: 'https://freedomtimes.news/contact-us' },
			],
			archives: [
				{ slug: 'a', updatedAt: null, seoCanonical: '/posts/elsewhere' },
				{ slug: 'b', updatedAt: null, seoCanonical: '/archives/b' },
			],
		});
		assert.deepEqual(urls.map((u) => u.loc), [
			'https://freedomtimes.news/',
			'https://freedomtimes.news/contact-us',
			'https://freedomtimes.news/archives',
			'https://freedomtimes.news/archives/b',
		]);
	});

	it('uses the request origin (no trailing slash duplication) and skips unroutable archive slugs', () => {
		const urls = buildSiteSitemapUrls('https://freedomtimes.news/', {
			postsUpdatedAt: null,
			pages: [],
			archives: [{ slug: 'a/b', updatedAt: null }, { slug: 'x?y', updatedAt: null }, { slug: '  ', updatedAt: null }, { slug: 'ok', updatedAt: null }],
		});
		assert.deepEqual(urls.map((u) => u.loc), ['https://freedomtimes.news/', 'https://freedomtimes.news/archives', 'https://freedomtimes.news/archives/ok']);
	});

	it('normalises lastmod to W3C Datetime like EmDash (space form is UTC; junk is dropped)', () => {
		assert.equal(toW3CDate('2026-10-01 12:30:00'), '2026-10-01T12:30:00.000Z');
		assert.equal(toW3CDate('2026-10-01T12:30:00+01:00'), '2026-10-01T11:30:00.000Z');
		assert.equal(toW3CDate('not a date'), null);
		assert.equal(toW3CDate(''), null);
		assert.equal(toW3CDate(null), null);
	});

	it('renders a valid urlset with escaped locs', () => {
		const xml = renderUrlset([{ loc: 'https://freedomtimes.news/a&b', lastmod: '2026-10-01T00:00:00.000Z' }, { loc: 'https://freedomtimes.news/' }]);
		assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
		assert.match(xml, /<loc>https:\/\/freedomtimes\.news\/a&amp;b<\/loc>\n {4}<lastmod>2026-10-01T00:00:00\.000Z<\/lastmod>/);
		assert.match(xml, /<url>\n {4}<loc>https:\/\/freedomtimes\.news\/<\/loc>\n {2}<\/url>/);
		assert.match(xml, /<\/urlset>$/);
	});

	it('is not an EmDash collection sitemap name and not one of the EmDash sitemap paths', () => {
		assert.equal(SITE_SITEMAP_PATH, '/sitemap-site-pages.xml');
		// EmDash's /sitemap-{collection}(-n).xml parser rejects "site-pages", so no collection can collide.
		assert.doesNotMatch('site-pages', /^([a-z][a-z0-9_]*)(?:-([2-9]|[1-9]\d{1,5}))?$/);
		assert.ok(!isKnownSitemapPath(SITE_SITEMAP_PATH));
	});
});

describe('middleware wiring (production only; staging unchanged)', () => {
	const src = readFileSync(new URL('../src/middleware.ts', import.meta.url), 'utf8');

	it('serves /sitemap-site-pages.xml only when the site is not locked', () => {
		assert.match(src, /const sitemapLocked = isLockedSiteAccess\(\);/);
		assert.match(src, /path === SITE_SITEMAP_PATH && !sitemapLocked\)/);
	});

	it('lists it in /sitemap.xml only when the site is not locked', () => {
		assert.match(src, /extraIndexSitemaps: sitemapLocked \? \[\] : \[SITE_SITEMAP_PATH\]/);
		assert.match(src, /locked: sitemapLocked,/);
	});

	it('site sitemap rows use EmDash’s indexable filter (published, not deleted, slug, not noindex)', () => {
		const db = readFileSync(new URL('../src/lib/site-sitemap-db.ts', import.meta.url), 'utf8');
		for (const clause of [
			/c\.status = 'published'/,
			/c\.deleted_at IS NULL/,
			/c\.slug IS NOT NULL/,
			/TRIM\(c\.slug\) <> ''/,
			/s\.seo_no_index IS NULL OR s\.seo_no_index = 0/,
		]) {
			assert.match(db, clause);
		}
	});
});
