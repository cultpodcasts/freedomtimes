import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	HOMEPAGE_POST_COLUMNS,
	mapHomepageRow,
	normalizeLocalMediaValue,
} from '../src/lib/content/homepage-entries-map.ts';

const homepageView = readFileSync(
	fileURLToPath(new URL('../src/components/HomepageView.astro', import.meta.url)),
	'utf8',
);

const homepageEntries = readFileSync(
	fileURLToPath(new URL('../src/lib/content/homepage-entries.ts', import.meta.url)),
	'utf8',
);

describe('homepage light query', () => {
	it('never selects the Portable Text body or SEO blobs', () => {
		const cols: readonly string[] = HOMEPAGE_POST_COLUMNS;
		for (const heavy of ['content', 'lede', 'people', 'organisations', 'places']) {
			assert.equal(cols.includes(heavy), false, heavy);
		}
		for (const needed of ['slug', 'title', 'excerpt', 'subjects', 'featured_image', 'published_at']) {
			assert.equal(cols.includes(needed), true, needed);
		}
	});

	it('the homepage uses loadHomepageEntries (100 posts), not a full collection load', () => {
		assert.match(homepageEntries, /export const HOMEPAGE_POST_LIMIT = 100;/);
		assert.match(homepageEntries, /loadHomepageEntries\(limit = HOMEPAGE_POST_LIMIT\)/);
		assert.doesNotMatch(homepageView, /getEmDashCollection\(/);
	});
});

describe('homepage: posts load in the page frontmatter, before rendering starts (#123)', () => {
	// A component's frontmatter runs after Astro has sent the 200 headers; a database failure there
	// cuts the body off. A throw in the page frontmatter renders src/pages/500.astro instead.
	it('HomepageView takes entries as a prop and never queries the database itself', () => {
		assert.doesNotMatch(homepageView, /loadHomepageEntries\(|getEmDashCollection\(|getDb\(/);
		assert.match(homepageView, /entries: HomepageEntry\[\]/);
	});

	for (const page of ['index.astro', 'homepage.astro', '[slug].astro']) {
		it(`src/pages/${page} awaits loadHomepageEntries() and passes it to HomepageView`, () => {
			const src = readFileSync(fileURLToPath(new URL(`../src/pages/${page}`, import.meta.url)), 'utf8');
			const [, frontmatter = '', template = ''] = src.split(/^---$/m);
			assert.match(frontmatter, /await loadHomepageEntries\(\)/);
			assert.match(template, /<HomepageView entries=\{/);
		});
	}
});

describe('mapHomepageRow mirrors the EmDash loader', () => {
	const row = {
		id: '01ABC',
		slug: 'weekly-summary-11-october-2026',
		status: 'published',
		title: 'Weekly summary',
		excerpt: 'Short',
		subjects: '["cult","court"]',
		featured_image: '{"provider":"local","src":"01M1XH4BAJ480X5RB7VS3JGN6A.png","alt":"x"}',
		created_at: '2026-10-10T08:00:00.000Z',
		updated_at: '2026-10-11T08:00:00.000Z',
		published_at: '2026-10-11T09:00:00.000Z',
	};

	it('uses the slug as entry id, maps dates to Date, parses JSON', () => {
		const entry = mapHomepageRow(row);
		assert.equal(entry.id, row.slug);
		assert.equal(entry.slug, row.slug);
		assert.ok(entry.data.publishedAt instanceof Date);
		assert.equal((entry.data.publishedAt as Date).toISOString(), row.published_at);
		assert.ok(entry.data.updatedAt instanceof Date);
		assert.ok(entry.data.createdAt instanceof Date);
		assert.deepEqual(entry.data.subjects, ['cult', 'court']);
		assert.equal(entry.data.title, 'Weekly summary');
	});

	it('normalises bare local media src like the loader', () => {
		const entry = mapHomepageRow(row);
		assert.deepEqual(entry.data.featured_image, {
			provider: 'local',
			src: '/_emdash/api/media/file/01M1XH4BAJ480X5RB7VS3JGN6A.png',
			id: '01M1XH4BAJ480X5RB7VS3JGN6A.png',
			alt: 'x',
		});
	});

	it('leaves absolute and external media untouched', () => {
		assert.deepEqual(normalizeLocalMediaValue({ provider: 'local', src: '/x.png' }), {
			provider: 'local',
			src: '/x.png',
		});
		assert.deepEqual(normalizeLocalMediaValue({ provider: 'r2', src: 'https://a/b.png' }), {
			provider: 'r2',
			src: 'https://a/b.png',
		});
	});

	it('null dates stay null; plain strings stay strings', () => {
		const entry = mapHomepageRow({ ...row, published_at: null, excerpt: 'not {json' });
		assert.equal(entry.data.publishedAt, null);
		assert.equal(entry.data.excerpt, 'not {json');
	});
});

describe('homepage light query: EmDash loader drift tripwire', () => {
	// src/lib/content/homepage-entries.ts mirrors emdash's collection loader
	// (locale, status = published, deleted_at IS NULL, ordering, byline hydration).
	// The mirror was diffed against emdash 1.3.1. Widening this range is a
	// deliberate act: re-diff `emdash` loader.ts against homepage-entries.ts first.
	const SUPPORTED = { min: [1, 3, 1], belowMinor: [1, 4] } as const;
	it('installed emdash is within the range the mirror was verified against (>=1.3.1 <1.4.0)', () => {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL('../node_modules/emdash/package.json', import.meta.url)), 'utf8'),
		) as { version: string };
		const [major, minor, patch] = pkg.version.split(/[.+-]/).map((n) => Number.parseInt(n, 10));
		const ok =
			major === SUPPORTED.belowMinor[0] &&
			minor < SUPPORTED.belowMinor[1] &&
			(minor > SUPPORTED.min[1] || (minor === SUPPORTED.min[1] && patch >= SUPPORTED.min[2]));
		assert.ok(
			ok,
			`emdash ${pkg.version} is outside >=1.3.1 <1.4.0. Re-diff node_modules/emdash loader (collection query: locale, status, deleted_at, ORDER BY, byline hydration) against src/lib/content/homepage-entries.ts, then update this range.`,
		);
	});
});
