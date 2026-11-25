import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
	SUBJECT_DIRECTORY_COLUMNS,
	SUBJECT_DISPLAY_COLUMNS,
	applySubjectDisplay,
	buildSubjectDirectory,
	indexableSubjectSitemapEntries,
	mapSubjectPostRow,
	parseSubjects,
	subjectPageForSlug,
	type SubjectPostRow,
} from '../src/lib/subjects/list.ts';
import { readSubjectDirectoryPages } from '../src/lib/subjects/load.ts';
import { isSubjectSlug, subjectPath, subjectSlug } from '../src/lib/subjects/slug.ts';

function row(partial: Partial<SubjectPostRow> & Pick<SubjectPostRow, 'id' | 'subjects'>): SubjectPostRow {
	return {
		slug: partial.slug ?? partial.id,
		title: partial.title ?? partial.id,
		excerpt: partial.excerpt ?? null,
		publishedAt: partial.publishedAt ?? '2026-01-01T00:00:00.000Z',
		updatedAt: partial.updatedAt ?? '2026-01-02T00:00:00.000Z',
		noindex: partial.noindex ?? false,
		...partial,
	};
}

describe('subject slugs', () => {
	it('folds case, accents, and punctuation into one hyphenated slug', () => {
		assert.equal(subjectSlug('  France '), 'france');
		assert.equal(subjectSlug('Child sexual abuse'), 'child-sexual-abuse');
		assert.equal(subjectSlug('Libération'), 'liberation');
		assert.equal(subjectSlug("L'Oréal"), 'l-oreal');
		assert.equal(subjectPath('France'), '/subjects/france');
		assert.equal(isSubjectSlug('child-sexual-abuse'), true);
	});

	it('drops a label that cannot become a url slug', () => {
		assert.equal(subjectSlug('   '), null);
		assert.equal(subjectSlug('---'), null);
		assert.equal(subjectPath('***'), null);
		assert.equal(isSubjectSlug('France'), false);
		assert.equal(isSubjectSlug(''), false);
	});
});

describe('subject directory (synthetic posts)', () => {
	it('lists only the exact subject, newest first, and ignores a longer word', () => {
		const pages = buildSubjectDirectory([
			row({ id: 'older', subjects: ['France'], publishedAt: '2026-01-01T00:00:00.000Z', title: 'Older' }),
			row({ id: 'newer', subjects: ['France'], publishedAt: '2026-06-01T00:00:00.000Z', title: 'Newer' }),
			row({ id: 'other', subjects: ['Frances'], title: 'Not France' }),
		]);
		const france = pages.find((page) => page.slug === 'france');
		const frances = pages.find((page) => page.slug === 'frances');
		assert.deepEqual(france?.posts.map((post) => post.id), ['newer', 'older']);
		assert.equal(france?.label, 'France');
		assert.deepEqual(frances?.posts.map((post) => post.id), ['other']);
	});

	it('keeps one url when two labels share a slug, and lists both posts', () => {
		const page = subjectPageForSlug(
			[
				row({
					id: 'accent',
					subjects: ['Libération'],
					title: 'Accent',
					publishedAt: '2026-02-01T00:00:00.000Z',
					updatedAt: '2026-02-02T00:00:00.000Z',
					noindex: false,
				}),
				row({
					id: 'plain',
					subjects: ['Liberation'],
					title: 'Plain',
					publishedAt: '2026-06-01T00:00:00.000Z',
					updatedAt: '2026-06-02T00:00:00.000Z',
					noindex: true,
				}),
			],
			'liberation',
		);
		assert.equal(page?.label, 'Liberation');
		assert.deepEqual(page?.posts.map((post) => post.id), ['plain', 'accent']);
		assert.equal(page?.indexable, true);
		assert.equal(page?.updatedAt, '2026-06-02T00:00:00.000Z');
	});

	it('lists a post once when it carries both spellings of one slug', () => {
		const page = subjectPageForSlug(
			[row({ id: 'both', subjects: ['Libération', 'Liberation', 'Liberation'] })],
			'liberation',
		);
		assert.deepEqual(page?.posts.map((post) => post.id), ['both']);
	});

	it('treats case variants as one label and prefers the capitalised spelling', () => {
		const page = subjectPageForSlug(
			[
				row({ id: 'lower', subjects: ['france'] }),
				row({ id: 'upper', subjects: ['France'] }),
			],
			'france',
		);
		assert.equal(page?.label, 'France');
		assert.deepEqual(page?.posts.map((post) => post.id).sort(), ['lower', 'upper']);
	});

	it('omits a subject from the sitemap when every post is noindex, and dates the rest from the newest update', () => {
		const rows = [
			row({ id: 'hidden', subjects: ['Secret'], noindex: true, updatedAt: '2026-08-01T00:00:00.000Z' }),
			row({ id: 'old', subjects: ['France'], noindex: false, updatedAt: '2026-03-01T00:00:00.000Z' }),
			row({ id: 'new', subjects: ['France'], noindex: true, updatedAt: '2026-09-01T00:00:00.000Z' }),
		];
		const france = subjectPageForSlug(rows, 'france');
		assert.equal(france?.indexable, true);
		assert.equal(france?.updatedAt, '2026-09-01T00:00:00.000Z');
		assert.equal(subjectPageForSlug(rows, 'secret')?.indexable, false);
		assert.deepEqual(indexableSubjectSitemapEntries(rows), [
			{ slug: 'france', updatedAt: '2026-09-01T00:00:00.000Z' },
		]);
	});

	it('parses a json array and maps a row without reading a body column', () => {
		assert.deepEqual(parseSubjects('["France"," Frances "]'), ['France', 'Frances']);
		const mapped = mapSubjectPostRow({
			id: 'p1',
			slug: 'a-post',
			title: 'A post',
			excerpt: ' Standfirst ',
			subjects: '["France"]',
			published_at: '2026-05-01 12:00:00',
			updated_at: '2026-05-02 12:00:00',
			seo_no_index: 0,
			content: 'this body must not become the title or the excerpt',
		});
		assert.equal(mapped?.excerpt, 'Standfirst');
		assert.deepEqual(mapped?.subjects, ['France']);
		assert.equal(mapped?.title, 'A post');
		assert.equal(mapped?.noindex, false);
		assert.equal(mapSubjectPostRow({ id: '', slug: 'x', seo_no_index: 1 }), null);
	});
});

describe('subject display fields', () => {
	it('fills title and excerpt only for posts already on the page', () => {
		const page = subjectPageForSlug(
			[row({ id: 'older', subjects: ['France'], title: 'Untitled post', excerpt: null })],
			'france',
		);
		assert.ok(page);
		const filled = applySubjectDisplay(page, [
			{ id: 'older', title: 'The France piece', excerpt: 'Standfirst' },
			{ id: 'someone-else', title: 'Not on this page', excerpt: 'Skip' },
		]);
		assert.equal(filled.posts[0]?.title, 'The France piece');
		assert.equal(filled.posts[0]?.excerpt, 'Standfirst');
		assert.equal(filled.posts.length, 1);
	});
});

describe('subject directory scan', () => {
	it('keeps a subject that only appears past the old 500-row cap', async () => {
		const total = 501;
		const pageSize = 200;
		const rows = Array.from({ length: total }, (_, index) => ({
			id: `p${String(index).padStart(4, '0')}`,
			slug: `post-${index}`,
			subjects: index === total - 1 ? '["Older subject"]' : '["Recent"]',
			published_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-02T00:00:00.000Z',
			seo_no_index: 0,
			content: 'body must not be required',
		}));
		let calls = 0;
		const loaded = await readSubjectDirectoryPages(async (afterId, limit) => {
			calls += 1;
			assert.equal(limit, pageSize);
			const start = afterId ? rows.findIndex((row) => row.id === afterId) + 1 : 0;
			return rows.slice(start, start + limit);
		}, pageSize);
		assert.equal(calls, 3);
		assert.equal(loaded.length, total);
		const page = subjectPageForSlug(loaded, 'older-subject');
		assert.equal(page?.posts[0]?.id, 'p0500');
		assert.equal(page?.indexable, true);
		const recent = subjectPageForSlug(loaded, 'recent');
		assert.equal(recent?.posts.length, 500);
	});

	it('throws when a full page does not advance, instead of dropping the tail', async () => {
		await assert.rejects(
			() => readSubjectDirectoryPages(async () => [{ id: 'same', slug: 's', subjects: '["France"]' }], 1),
			/did not advance/,
		);
	});
});

describe('subject query shape', () => {
	it('scans directory columns only, then loads title and excerpt for one page', () => {
		assert.deepEqual([...SUBJECT_DIRECTORY_COLUMNS], ['id', 'slug', 'subjects', 'published_at', 'updated_at']);
		assert.deepEqual([...SUBJECT_DISPLAY_COLUMNS], ['id', 'title', 'excerpt']);
		const source = readFileSync(new URL('../src/lib/subjects/load.ts', import.meta.url), 'utf8');
		assert.match(source, /sql\.ref\('c\.status'\)\} = \$\{'published'\}/);
		assert.match(source, /sql\.ref\('c\.deleted_at'\)\} IS NULL/);
		assert.match(source, /readSubjectDirectoryPages/);
		assert.doesNotMatch(source, /sql\.raw|SUBJECT_LIST_LIMIT|LIMIT 500|SELECT \*|c\.content|c\."content"/);
		const page = readFileSync(new URL('../src/pages/subjects/[slug].astro', import.meta.url), 'utf8');
		const directoryCall = page.indexOf('await loadPublishedSubjectRows');
		const choose = page.indexOf('subjectPageForSlug(rows');
		const displayCall = page.indexOf('await loadSubjectPagePosts');
		assert.ok(directoryCall >= 0 && choose > directoryCall && displayCall > choose);
	});
});
