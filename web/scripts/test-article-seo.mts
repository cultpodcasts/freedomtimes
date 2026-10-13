import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	PUBLISHER_LOGO_PATH,
	buildBreadcrumbJsonLd,
	buildNewsArticleJsonLd,
	findWeeklyNeighbours,
	readArticleStructuredFields,
	resolveArticleMeta,
	resolveCanonicalRedirect,
	serializeJsonLd,
} from '../src/lib/seo/article-seo.ts';

const ORIGIN = 'https://freedomtimes.news';
const EMPTY = readArticleStructuredFields({});

describe('resolveArticleMeta fallbacks', () => {
	const base = {
		title: 'Europe & UK Cult News: 4–10 October 2026',
		summaryParagraphs: ['First para.', 'Second para.'],
		canonicalPath: '/posts/weekly-summary-11-october-2026',
		fallbackDescription: 'fallback',
	};

	it('falls back to title, first excerpt paragraph, own URL, indexable when SEO record is empty', () => {
		const meta = resolveArticleMeta({ ...base, seo: null, fields: EMPTY });
		assert.deepEqual(meta, {
			title: base.title,
			socialTitle: base.title,
			description: 'First para.',
			canonical: base.canonicalPath,
			noindex: false,
		});
	});

	it('treats blank SEO values as empty', () => {
		const meta = resolveArticleMeta({ ...base, seo: { title: '  ', description: '', canonical: '' }, fields: EMPTY });
		assert.equal(meta.title, base.title);
		assert.equal(meta.description, 'First para.');
		assert.equal(meta.canonical, base.canonicalPath);
	});

	it('uses seo.title, seo.description, seo.canonical, seo.noIndex', () => {
		const meta = resolveArticleMeta({
			...base,
			seo: { title: 'SEO title', description: 'SEO desc', canonical: 'https://freedomtimes.news/posts/x', noIndex: true },
			fields: EMPTY,
		});
		assert.equal(meta.title, 'SEO title');
		assert.equal(meta.socialTitle, 'SEO title');
		assert.equal(meta.description, 'SEO desc');
		assert.equal(meta.canonical, 'https://freedomtimes.news/posts/x');
		assert.equal(meta.noindex, true);
	});

	it('social_title only overrides og:title and never adds a date suffix', () => {
		const meta = resolveArticleMeta({ ...base, seo: null, fields: { socialTitle: 'Short social' } });
		assert.equal(meta.title, base.title);
		assert.equal(meta.socialTitle, 'Short social');
		assert.doesNotMatch(resolveArticleMeta({ ...base, seo: null, fields: EMPTY }).socialTitle, / - \d{2} \w{3} \d{4}$/);
	});

	it('ignores non-http canonical values', () => {
		const meta = resolveArticleMeta({ ...base, seo: { canonical: 'javascript:alert(1)' }, fields: EMPTY });
		assert.equal(meta.canonical, base.canonicalPath);
	});

	it('falls back to the generic description with no excerpt', () => {
		assert.equal(resolveArticleMeta({ ...base, summaryParagraphs: [], seo: null, fields: EMPTY }).description, 'fallback');
	});
});

describe('readArticleStructuredFields', () => {
	it('normalizes discrete fields, drops empties/dupes/bad urls, accepts JSON strings', () => {
		const fields = readArticleStructuredFields({
			lede: '  Paris court jails guru.  ',
			coverage_start: '2026-10-04T00:00:00.000Z',
			coverage_end: '2026-10-10',
			people: [{ name: 'Rohan Rane', url: 'https://example.org/rr' }, { name: 'rohan rane' }, { name: '' }, 'Jane Doe'],
			organisations: JSON.stringify([{ name: 'CVLT', type: 'cult', url: 'javascript:x' }]),
			places: [{ name: 'Paris' }, { name: 'Médoc' }],
			social_title: '',
		});
		assert.deepEqual(fields, {
			lede: 'Paris court jails guru.',
			coverageStart: '2026-10-04',
			coverageEnd: '2026-10-10',
			people: [{ name: 'Rohan Rane', url: 'https://example.org/rr' }, { name: 'Jane Doe' }],
			organisations: [{ name: 'CVLT', type: 'cult' }],
			places: [{ name: 'Paris' }, { name: 'Médoc' }],
			socialTitle: null,
		});
	});
});

describe('buildNewsArticleJsonLd', () => {
	const input = {
		origin: ORIGIN,
		canonicalUrl: `${ORIGIN}/posts/weekly-summary-11-october-2026`,
		headline: 'Europe & UK Cult News: 4–10 October 2026',
		description: 'Excerpt first para.',
		fields: EMPTY,
		publishedAt: '2026-10-11T08:00:00.000Z',
		updatedAt: '2026-10-12T09:30:00.000Z',
		bylineName: 'freedom times',
		imageUrls: ['/_emdash/api/media/file/abc.png', '/_emdash/api/media/file/abc.png'],
		subjects: ['PBCC', 'France'],
		siteName: 'freedom times',
	};

	it('includes required NewsArticle properties and omits empty ones', () => {
		const ld = buildNewsArticleJsonLd(input);
		assert.equal(ld['@type'], 'NewsArticle');
		assert.equal(ld.headline, input.headline);
		assert.equal(ld.datePublished, '2026-10-11T08:00:00.000Z');
		assert.equal(ld.dateModified, '2026-10-12T09:30:00.000Z');
		assert.deepEqual(ld.image, [`${ORIGIN}/_emdash/api/media/file/abc.png`]);
		assert.deepEqual(ld.mainEntityOfPage, { '@type': 'WebPage', '@id': input.canonicalUrl });
		assert.deepEqual(ld.author, { '@type': 'Organization', name: 'freedom times', url: `${ORIGIN}/` });
		const publisher = ld.publisher as Record<string, unknown>;
		assert.equal((publisher.logo as Record<string, unknown>).url, `${ORIGIN}${PUBLISHER_LOGO_PATH}`);
		assert.equal(ld.keywords, 'PBCC, France');
		assert.equal(ld.description, 'Excerpt first para.');
		for (const key of ['about', 'mentions', 'spatialCoverage', 'temporalCoverage', 'articleSection']) {
			assert.equal(key in ld, false, `${key} should be omitted when empty`);
		}
	});

	it('builds about/mentions/spatial/temporal coverage from discrete fields; lede wins description', () => {
		const ld = buildNewsArticleJsonLd({
			...input,
			bylineName: 'Jane Reporter',
			imageUrls: [],
			subjects: [],
			fields: readArticleStructuredFields({
				lede: 'Lede sentence.',
				coverage_start: '2026-10-04',
				coverage_end: '2026-10-10',
				people: [{ name: 'Rohan Rane' }],
				organisations: [{ name: 'CVLT', type: 'cult' }],
				places: [{ name: 'Paris' }],
			}),
			section: { name: 'Weekly summaries', url: '/weekly-summaries' },
		});
		assert.equal(ld.description, 'Lede sentence.');
		assert.deepEqual(ld.author, { '@type': 'Person', name: 'Jane Reporter' });
		assert.deepEqual(ld.about, [{ '@type': 'Organization', name: 'CVLT', description: 'cult' }]);
		assert.deepEqual(ld.mentions, [{ '@type': 'Person', name: 'Rohan Rane' }]);
		assert.deepEqual(ld.spatialCoverage, [{ '@type': 'Place', name: 'Paris' }]);
		assert.equal(ld.temporalCoverage, '2026-10-04/2026-10-10');
		assert.equal(ld.articleSection, 'Weekly summaries');
		assert.equal('image' in ld, false);
		assert.equal('keywords' in ld, false);
	});

	it('omits author and dates when missing', () => {
		const ld = buildNewsArticleJsonLd({ ...input, bylineName: null, publishedAt: null, updatedAt: null });
		assert.equal('author' in ld, false);
		assert.equal('datePublished' in ld, false);
		assert.equal('dateModified' in ld, false);
	});

	it('serializes safely inside a script tag', () => {
		const out = serializeJsonLd({ headline: '</script><script>alert(1)</script> & co' });
		assert.doesNotMatch(out, /<\/script>/i);
		assert.equal(JSON.parse(out).headline, '</script><script>alert(1)</script> & co');
	});
});

describe('buildBreadcrumbJsonLd', () => {
	it('starts at the site root and numbers positions', () => {
		const ld = buildBreadcrumbJsonLd({
			origin: ORIGIN,
			siteName: 'freedom times',
			trail: [{ name: 'Weekly summaries', url: '/weekly-summaries' }, { name: 'Post', url: `${ORIGIN}/posts/x` }],
		});
		assert.deepEqual(ld.itemListElement, [
			{ '@type': 'ListItem', position: 1, name: 'freedom times', item: `${ORIGIN}/` },
			{ '@type': 'ListItem', position: 2, name: 'Weekly summaries', item: `${ORIGIN}/weekly-summaries` },
			{ '@type': 'ListItem', position: 3, name: 'Post', item: `${ORIGIN}/posts/x` },
		]);
	});
});

describe('findWeeklyNeighbours', () => {
	const items = [
		{ slug: 'weekly-summary-11-october-2026', title: 'C', sortDate: '2026-10-04' },
		{ slug: 'weekly-summary-27-september-2026', title: 'A', sortDate: '2026-09-20T08:00:00Z' },
		{ slug: 'weekly-summary-4-october-2026', title: 'B', sortDate: '2026-09-27' },
	];
	it('orders by coverage/published date', () => {
		const mid = findWeeklyNeighbours(items, 'weekly-summary-4-october-2026');
		assert.equal(mid.previous?.title, 'A');
		assert.equal(mid.next?.title, 'C');
		assert.equal(findWeeklyNeighbours(items, 'weekly-summary-27-september-2026').previous, null);
		assert.equal(findWeeklyNeighbours(items, 'weekly-summary-11-october-2026').next, null);
		assert.deepEqual(findWeeklyNeighbours(items, 'nope'), { previous: null, next: null });
	});
});

describe('resolveCanonicalRedirect', () => {
	it('301 targets', () => {
		assert.equal(resolveCanonicalRedirect('/posts/weekly-summary-11-october-2026/'), '/posts/weekly-summary-11-october-2026');
		assert.equal(resolveCanonicalRedirect('/posts/abc//', '?x=1'), '/posts/abc?x=1');
		assert.equal(resolveCanonicalRedirect('/weekly-summaries/'), '/weekly-summaries');
		assert.equal(resolveCanonicalRedirect('/posts/contact-us'), '/contact-us');
		assert.equal(resolveCanonicalRedirect('/posts/about-us/'), '/about-us');
	});
	it('leaves canonical URLs alone', () => {
		for (const path of ['/', '/posts/abc', '/weekly-summaries', '/contact-us', '/archives/', '/_emdash/admin/', '/posts/abc/edit']) {
			assert.equal(resolveCanonicalRedirect(path), null, path);
		}
	});
});
