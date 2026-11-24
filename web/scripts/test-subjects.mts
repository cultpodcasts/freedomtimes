import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
	SUBJECT_POST_COLUMNS,
	buildSubjectDirectory,
	indexableSubjectSitemapEntries,
	mapSubjectPostRow,
	parseSubjects,
	subjectPageForSlug,
	type SubjectPostRow,
} from '../src/lib/subjects/list.ts';
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

	it('keeps one url when two labels share a slug, and lists only the winning label', () => {
		const page = subjectPageForSlug(
			[
				row({ id: 'accent', subjects: ['Libération'], title: 'Accent' }),
				row({ id: 'plain', subjects: ['Liberation'], title: 'Plain' }),
			],
			'liberation',
		);
		assert.equal(page?.label, 'Liberation');
		assert.deepEqual(page?.posts.map((post) => post.id), ['plain']);
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

describe('subject query shape', () => {
	it('selects the narrow columns and never the post body', () => {
		assert.deepEqual([...SUBJECT_POST_COLUMNS], ['id', 'slug', 'title', 'excerpt', 'subjects', 'published_at', 'updated_at']);
		assert.ok(!SUBJECT_POST_COLUMNS.includes('content' as 'id'));
		const source = readFileSync(new URL('../src/lib/subjects/load.ts', import.meta.url), 'utf8');
		assert.match(source, /c\.status = \$\{'published'\}/);
		assert.match(source, /c\.deleted_at IS NULL/);
		assert.doesNotMatch(source, /SELECT \*|c\.content|c\."content"/);
	});
});
