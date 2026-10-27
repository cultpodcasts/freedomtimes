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

	it('HomepageView uses loadHomepageEntries, not a full collection load', () => {
		assert.match(homepageView, /loadHomepageEntries\(100\)/);
		assert.doesNotMatch(homepageView, /getEmDashCollection\(/);
	});
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
