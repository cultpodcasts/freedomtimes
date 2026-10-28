import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	genericHeroImageAlt,
	readImageAlt,
	resolveHeroImageAlt,
} from '../src/lib/content/imageAlt.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const title = 'Weekly Summary: 11 October 2026';
const generic = `${title} featured image`;

/** Shape EmDash 1.3.1 stores for an image field on a post (ImageValue). */
function imageValue(alt?: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: '01M2DW4H4PB5X0AEC83M40GN7R',
		provider: 'local',
		...(alt === undefined ? {} : { alt }),
		meta: { storageKey: '01M2DW4H4PB5X0AEC83M40GN7R.jpg' },
		...extra,
	};
}

describe('readImageAlt', () => {
	it('reads the alt stored on an EmDash image value', () => {
		assert.equal(readImageAlt(imageValue('Protesters outside the court')), 'Protesters outside the court');
	});

	it('trims surrounding whitespace', () => {
		assert.equal(readImageAlt(imageValue('  A courtroom sketch \n')), 'A courtroom sketch');
	});

	it('treats missing, empty and whitespace-only alt as absent', () => {
		assert.equal(readImageAlt(imageValue()), null);
		assert.equal(readImageAlt(imageValue('')), null);
		assert.equal(readImageAlt(imageValue('   ')), null);
	});

	it('falls back to meta.alt and a nested asset alt', () => {
		assert.equal(readImageAlt({ id: 'x', meta: { alt: 'From meta' } }), 'From meta');
		assert.equal(readImageAlt({ asset: { alt: 'From asset' } }), 'From asset');
		assert.equal(readImageAlt({ asset: { meta: { alt: 'From asset meta' } } }), 'From asset meta');
		assert.equal(readImageAlt({ alt: '', meta: { alt: 'From meta' } }), 'From meta');
	});

	it('parses a JSON-string image value', () => {
		assert.equal(readImageAlt(JSON.stringify(imageValue('From JSON'))), 'From JSON');
	});

	it('returns null for non-image values', () => {
		for (const value of [null, undefined, '', 'https://example.com/a.jpg', '{not json', 42, [], ['x']]) {
			assert.equal(readImageAlt(value), null, `value ${JSON.stringify(value)}`);
		}
	});

	it('ignores a non-string alt', () => {
		assert.equal(readImageAlt({ id: 'x', alt: 7 }), null);
	});
});

describe('resolveHeroImageAlt (#108)', () => {
	it('uses featured_image.alt instead of the generic text', () => {
		assert.equal(
			resolveHeroImageAlt({ featured_image: imageValue('Survivors at the vigil') }, title, 'featured_image'),
			'Survivors at the vigil',
		);
	});

	it('prefers the stored alt over legacy flat alt fields', () => {
		assert.equal(
			resolveHeroImageAlt(
				{ featured_image: imageValue('Stored alt'), featured_image_alt: 'Legacy alt', cover_image_alt: 'Legacy cover' },
				title,
				'featured_image',
			),
			'Stored alt',
		);
	});

	it('uses cover_image.alt when the cover image is the rendered hero', () => {
		assert.equal(
			resolveHeroImageAlt({ cover_image: imageValue('Front page of issue 3') }, title, 'cover_image'),
			'Front page of issue 3',
		);
	});

	it('reads alt only from the image actually rendered', () => {
		const data = { featured_image: imageValue('Featured alt'), cover_image: imageValue('Cover alt') };
		assert.equal(resolveHeroImageAlt(data, title, 'featured_image'), 'Featured alt');
		assert.equal(resolveHeroImageAlt(data, title, 'cover_image'), 'Cover alt');
		assert.equal(
			resolveHeroImageAlt({ featured_image: imageValue(), cover_image: imageValue('Cover alt') }, title, 'featured_image'),
			generic,
		);
	});

	it('keeps the legacy flat alt fields as the next fallback', () => {
		assert.equal(
			resolveHeroImageAlt({ featured_image: imageValue(''), featured_image_alt: 'Legacy alt' }, title, 'featured_image'),
			'Legacy alt',
		);
		assert.equal(
			resolveHeroImageAlt({ cover_image: imageValue(), cover_image_alt: 'Legacy cover' }, title, 'cover_image'),
			'Legacy cover',
		);
	});

	it('falls back to the current generic text only when no alt is stored', () => {
		assert.equal(resolveHeroImageAlt({ featured_image: imageValue() }, title, 'featured_image'), generic);
		assert.equal(resolveHeroImageAlt({ featured_image: imageValue('  ') }, title, 'featured_image'), generic);
		assert.equal(resolveHeroImageAlt({ featured_image: '/_emdash/api/media/file/a.jpg' }, title, 'featured_image'), generic);
		assert.equal(resolveHeroImageAlt({}, title, 'cover_image'), generic);
		assert.equal(genericHeroImageAlt(title), generic);
	});
});

describe('hero alt wiring (source guard)', () => {
	const contentEntry = read('../src/lib/content/contentEntry.ts');
	const entryMedia = read('../src/components/content/EntryMedia.astro');

	it('contentEntry builds featuredImageAlt with resolveHeroImageAlt for the rendered field', () => {
		assert.match(contentEntry, /import \{ resolveHeroImageAlt \} from '\.\/imageAlt';/);
		assert.match(
			contentEntry,
			/const featuredImageAlt = resolveHeroImageAlt\(\s*data,\s*title,\s*featuredImageFromFeatured \? 'featured_image' : 'cover_image',\s*\);/,
		);
		assert.doesNotMatch(contentEntry, /`\$\{title\} featured image`/);
	});

	it('the hero <img> renders featuredImageAlt', () => {
		assert.match(entryMedia, /<img src=\{featuredImageSrc\} alt=\{featuredImageAlt\}/);
	});
});
