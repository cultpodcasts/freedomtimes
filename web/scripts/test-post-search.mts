import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { excerptRuns } from '../src/lib/search/excerpt.ts';
import { readSearchImage, searchSnippet, subjectsForSearch } from '../src/lib/search/result.ts';
import {
	POST_SEARCH_FIELDS,
	SEARCH_DISPLAY_COLUMNS,
	SEARCH_QUERY_MAX_LENGTH,
	isSafeSearchCursor,
	mapSearchDisplayRow,
	normalizeSearchQuery,
	orderPublishedHits,
	type SearchDisplayRow,
} from '../src/lib/search/query.ts';

function hit(partial: Partial<SearchDisplayRow> & Pick<SearchDisplayRow, 'id'>): SearchDisplayRow {
	return {
		slug: partial.slug ?? partial.id,
		title: partial.title ?? partial.id,
		excerpt: partial.excerpt ?? null,
		subjects: partial.subjects ?? [],
		imageSrc: partial.imageSrc ?? null,
		imageAlt: partial.imageAlt ?? null,
		publishedAt: partial.publishedAt ?? null,
		...partial,
	};
}

describe('search query', () => {
	it('rejects an empty query and a query over 200 characters', () => {
		assert.deepEqual(normalizeSearchQuery(null), { ok: false, reason: 'empty' });
		assert.deepEqual(normalizeSearchQuery('   '), { ok: false, reason: 'empty' });
		assert.deepEqual(normalizeSearchQuery('  france  '), { ok: true, query: 'france' });
		assert.equal(SEARCH_QUERY_MAX_LENGTH, 200);
		assert.deepEqual(normalizeSearchQuery('a'.repeat(200)), { ok: true, query: 'a'.repeat(200) });
		assert.deepEqual(normalizeSearchQuery('a'.repeat(201)), { ok: false, reason: 'too_long' });
	});

	it('accepts an EmDash cursor and rejects anything that could change the query', () => {
		assert.equal(isSafeSearchCursor('eyJvcmRlclZhbHVlIjoiMSIsImlkIjoic2VhcmNoIn0='), true);
		assert.equal(isSafeSearchCursor(''), false);
		assert.equal(isSafeSearchCursor(null), false);
		assert.equal(isSafeSearchCursor('abc" OR 1=1'), false);
		assert.equal(isSafeSearchCursor('a'.repeat(2049)), false);
	});
});

describe('search display rows (synthetic)', () => {
	it('keeps FTS order and drops an id that is not in the published rows', () => {
		const hits = orderPublishedHits(
			['draft', 'second', 'first', 'second'],
			[hit({ id: 'first', title: 'First' }), hit({ id: 'second', title: 'Second' }), hit({ id: 'extra', title: 'Not ranked' })],
		);
		assert.deepEqual(hits.map((row) => row.id), ['second', 'first']);
	});

	it('maps a narrow row and ignores a body column', () => {
		const mapped = mapSearchDisplayRow({
			id: 'p1',
			slug: 'a-post',
			title: 'A post',
			excerpt: ' The standfirst ',
			subjects: ['France', 'Paris'],
			published_at: '2026-04-01T00:00:00.000Z',
			content: 'body text that must not be copied onto the card',
		});
		assert.equal(mapped?.excerpt, 'The standfirst');
		assert.equal(mapped?.imageSrc, null);
		const withImage = mapSearchDisplayRow({
			id: 'p1',
			slug: 'a-post',
			title: 'A post',
			featured_image: JSON.stringify({
				provider: 'local',
				meta: { storageKey: 'photo-key' },
				alt: 'A hall',
			}),
		});
		assert.equal(withImage?.imageSrc, '/_emdash/api/media/file/photo-key');
		assert.equal(withImage?.imageAlt, 'A hall');
		assert.equal(readSearchImage({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })?.src, '/_emdash/api/media/file/01ARZ3NDEKTSV4RRFFQ69G5FAV');
		assert.deepEqual(mapped?.subjects, ['France', 'Paris']);
		assert.equal(mapped?.title, 'A post');
		assert.equal(mapSearchDisplayRow({ id: 'p1', slug: '  ', content: 'body' }), null);
	});
});

describe('search standfirst italics', () => {
	it('turns outlet emphasis into italics and leaves a token underscore alone', () => {
		const runs = excerptRuns('_Politiken_ published Noah Rosendal. Emily Watson told _Variety_ the rest. some_word_more stays.');
		assert.deepEqual(runs, [
			{ text: 'Politiken', emphasis: true },
			{ text: ' published Noah Rosendal. Emily Watson told ', emphasis: false },
			{ text: 'Variety', emphasis: true },
			{ text: ' the rest. some_word_more stays.', emphasis: false },
		]);
		assert.deepEqual(excerptRuns('part in _Breaking the Waves_. RTBF and _La Libre_ reported.'), [
			{ text: 'part in ', emphasis: false },
			{ text: 'Breaking the Waves', emphasis: true },
			{ text: '. RTBF and ', emphasis: false },
			{ text: 'La Libre', emphasis: true },
			{ text: ' reported.', emphasis: false },
		]);
	});
});

describe('search hit display', () => {
	it('windows the standfirst on the match and keeps four subjects, match first', () => {
		const snippet = searchSnippet(
			`${'In Scotland the court sat. '.repeat(12)}Emily Watson told _Variety_ the School of Economic Science in London tried to stop the film.`,
			'london',
		);
		const text = snippet.map((run) => run.text).join('');
		assert.match(text, /^…/);
		assert.equal(snippet.some((run) => run.mark && run.text.toLowerCase() === 'london'), true);
		assert.equal(snippet.some((run) => run.emphasis && run.text === 'Variety'), true);
		assert.ok(text.length < 260);
		const subjects = subjectsForSearch(
			['Europe & UK cult news', 'UK', 'Europe', 'Switzerland', 'Scotland', 'Malta', 'London'],
			'london',
		);
		assert.equal(subjects.shown[0], 'London');
		assert.equal(subjects.shown.length, 4);
		assert.equal(subjects.more, 3);
	});
});

describe('search fields and query shape', () => {
	it('seed.json marks excerpt, lede, and subjects searchable, with title and content', () => {
		const seed = JSON.parse(readFileSync(new URL('../.emdash/seed.json', import.meta.url), 'utf8')) as {
			collections: { slug: string; fields: { slug: string; searchable?: boolean }[] }[];
		};
		const posts = seed.collections.find((collection) => collection.slug === 'posts');
		assert.ok(posts);
		const searchable = posts.fields.filter((field) => field.searchable).map((field) => field.slug);
		assert.deepEqual(new Set(searchable), new Set(POST_SEARCH_FIELDS));
		assert.equal(searchable.length, POST_SEARCH_FIELDS.length);
		for (const slug of ['people', 'places', 'organisations']) {
			assert.equal(posts.fields.find((field) => field.slug === slug)?.searchable, undefined);
		}
	});

	it('hydrates published posts without selecting the body, and forces published status', () => {
		assert.deepEqual([...SEARCH_DISPLAY_COLUMNS], ['id', 'slug', 'title', 'excerpt', 'subjects', 'featured_image', 'published_at']);
		const source = readFileSync(new URL('../src/lib/search/post-search.ts', import.meta.url), 'utf8');
		assert.match(source, /collections: \['posts'\]/);
		assert.match(source, /status: 'published'/);
		assert.match(source, /AND status = \$\{'published'\}/);
		assert.match(source, /deleted_at IS NULL/);
		assert.doesNotMatch(source, /SELECT \*|"content"|'content'/);
	});
});
