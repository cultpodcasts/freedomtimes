import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { genericHeroImageAlt, resolveHeroImage, storedHeroImageAlt } from '../src/lib/content/heroImage.ts';
import { readImageAlt } from '../src/lib/content/imageAlt.ts';
import { readImageCaption } from '../src/lib/content/imageCaption.ts';
import { asMediaRecord, readMediaValueSrc, readTrimmedString } from '../src/lib/content/mediaValue.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const title = 'Weekly Summary: 11 October 2026';
const generic = `${title} featured image`;
const featuredKey = '01M2DW4H4PB5X0AEC83M40GN7R.jpg';
const coverKey = '01M2DW4H4PB5X0AEC83M40GN7S.png';
const featuredPath = `/_emdash/api/media/file/${featuredKey}`;
const coverPath = `/_emdash/api/media/file/${coverKey}`;

/** Shape EmDash 1.3.1 stores for an image field on a post (ImageValue). */
function imageValue(alt?: string, storageKey: string | null = featuredKey, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: '01M2DW4H4PB5X0AEC83M40GN7R',
		provider: 'local',
		...(alt === undefined ? {} : { alt }),
		...(storageKey === null ? {} : { meta: { storageKey } }),
		...extra,
	};
}

describe('mediaValue helpers', () => {
	it('readTrimmedString trims and treats blank as absent', () => {
		assert.equal(readTrimmedString('  a  '), 'a');
		assert.equal(readTrimmedString('   '), null);
		assert.equal(readTrimmedString(3), null);
	});

	it('asMediaRecord accepts objects and JSON-object strings only', () => {
		assert.deepEqual(asMediaRecord({ a: 1 }), { a: 1 });
		assert.deepEqual(asMediaRecord(' {"a":1} '), { a: 1 });
		for (const value of [null, undefined, '', 'x', '{bad', '[1]', [], 42]) {
			assert.equal(asMediaRecord(value), null, `value ${JSON.stringify(value)}`);
		}
	});

	it('readMediaValueSrc reads storageKey, src/url, string paths and JSON strings', () => {
		assert.equal(readMediaValueSrc(imageValue('x')), featuredPath);
		assert.equal(readMediaValueSrc({ storage_key: featuredKey }), featuredPath);
		assert.equal(readMediaValueSrc({ src: featuredPath }), featuredPath);
		assert.equal(readMediaValueSrc(featuredPath), featuredPath);
		assert.equal(readMediaValueSrc(JSON.stringify(imageValue('x'))), featuredPath);
	});

	it('readMediaValueSrc is null when the value has no file', () => {
		assert.equal(readMediaValueSrc(imageValue('Alt only', null)), null);
		assert.equal(readMediaValueSrc(''), null);
		assert.equal(readMediaValueSrc(null), null);
	});
});

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

	it('returns null for non-image values and non-string alt', () => {
		for (const value of [null, undefined, '', 'https://example.com/a.jpg', '{not json', 42, [], ['x']]) {
			assert.equal(readImageAlt(value), null, `value ${JSON.stringify(value)}`);
		}
		assert.equal(readImageAlt({ id: 'x', alt: 7 }), null);
	});
});

describe('readImageCaption (shared helpers)', () => {
	it('reads the same shapes as readImageAlt, including a JSON-string value', () => {
		assert.equal(readImageCaption(imageValue('a', featuredKey, { caption: ' Photo: FT ' })), 'Photo: FT');
		assert.equal(readImageCaption({ meta: { caption: 'From meta' } }), 'From meta');
		assert.equal(readImageCaption({ asset: { meta: { caption: 'From asset meta' } } }), 'From asset meta');
		assert.equal(readImageCaption(JSON.stringify(imageValue('a', featuredKey, { caption: 'From JSON' }))), 'From JSON');
		assert.equal(readImageCaption(imageValue('a')), null);
		assert.equal(readImageCaption('plain string'), null);
	});
});

describe('resolveHeroImage (#108)', () => {
	it('featured image wins: src and alt both from featured_image', () => {
		assert.deepEqual(
			resolveHeroImage(
				{ featured_image: imageValue('Survivors at the vigil'), cover_image: imageValue('Cover alt', coverKey) },
				title,
			),
			{ field: 'featured_image', src: featuredPath, alt: 'Survivors at the vigil' },
		);
	});

	it('featured image with alt but no file: the cover is the hero, with the cover alt', () => {
		assert.deepEqual(
			resolveHeroImage(
				{ featured_image: imageValue('Orphan featured alt', null), cover_image: imageValue('Front page of issue 3', coverKey) },
				title,
			),
			{ field: 'cover_image', src: coverPath, alt: 'Front page of issue 3' },
		);
	});

	it('accepts a JSON-string featured value', () => {
		assert.deepEqual(
			resolveHeroImage({ featured_image: JSON.stringify(imageValue('From JSON')) }, title),
			{ field: 'featured_image', src: featuredPath, alt: 'From JSON' },
		);
	});

	it('a plain string featured path has no stored alt: generic fallback', () => {
		assert.deepEqual(
			resolveHeroImage({ featured_image: featuredPath }, title),
			{ field: 'featured_image', src: featuredPath, alt: generic },
		);
	});

	it('neither image has a file: src null, generic alt', () => {
		assert.deepEqual(resolveHeroImage({}, title), { field: null, src: null, alt: generic });
		assert.deepEqual(
			resolveHeroImage({ featured_image: imageValue('A', null), cover_image: imageValue('B', null) }, title),
			{ field: null, src: null, alt: generic },
		);
	});

	it('does not borrow the other image\'s stored alt', () => {
		assert.equal(
			resolveHeroImage({ featured_image: imageValue(), cover_image: imageValue('Cover alt', coverKey) }, title).alt,
			generic,
		);
	});

	it('stored alt beats legacy flat alt fields', () => {
		assert.equal(
			resolveHeroImage(
				{ featured_image: imageValue('Stored alt'), featured_image_alt: 'Legacy alt', cover_image_alt: 'Legacy cover' },
				title,
			).alt,
			'Stored alt',
		);
	});

	it('legacy flat alt fields follow the hero field', () => {
		const legacy = { featured_image_alt: 'Legacy featured', cover_image_alt: 'Legacy cover' };
		assert.equal(resolveHeroImage({ featured_image: imageValue(), ...legacy }, title).alt, 'Legacy featured');
		assert.equal(
			resolveHeroImage({ featured_image: imageValue('x', null), cover_image: imageValue(undefined, coverKey), ...legacy }, title).alt,
			'Legacy cover',
		);
		assert.equal(
			resolveHeroImage({ cover_image: imageValue(undefined, coverKey), featured_image_alt: 'Legacy featured' }, title).alt,
			'Legacy featured',
		);
		assert.equal(resolveHeroImage({ ...legacy }, title).alt, 'Legacy featured');
	});

	it('blank stored alt falls back to the generic text', () => {
		assert.equal(resolveHeroImage({ featured_image: imageValue('  ') }, title).alt, generic);
		assert.equal(genericHeroImageAlt(title), generic);
	});

	it('og:image:alt uses a stored hero alt and skips the generic one (#132)', () => {
		assert.equal(storedHeroImageAlt('Court sketch', title), 'Court sketch');
		assert.equal(storedHeroImageAlt(`  ${generic}  `, title), null);
		assert.equal(storedHeroImageAlt('   ', title), null);
	});
});

describe('hero image wiring (source guard)', () => {
	it('contentEntry takes featuredImageSrc and featuredImageAlt from resolveHeroImage', () => {
		const contentEntry = read('../src/lib/content/contentEntry.ts');
		assert.match(contentEntry, /from '\.\/heroImage'/);
		assert.match(contentEntry, /resolveHeroImage\(data, title\)/);
	});

	it('the hero <img> renders featuredImageAlt', () => {
		const entryMedia = read('../src/components/content/EntryMedia.astro');
		assert.match(entryMedia, /<img src=\{featuredImageSrc\} alt=\{featuredImageAlt\}/);
	});
});
