/**
 * #125: the social / OG image resolver runs from EmDashContentView.astro's component frontmatter,
 * after the 200 headers are sent. It must never reject: a throwing libsql client constructor or
 * query degrades to the next fallback (ultimately the hero image) and is logged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client/web';
import {
	extractImageFieldMediaIdForLookup,
	resolveSocialImageSrcWith,
	type SocialImageClientFactory,
	type SocialImageQueryClient,
} from '../src/lib/content/socialImage.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const HERO_KEY = '01M2DW4H4PB5X0AEC83M40GN7R.jpg';
const HERO_PATH = `/_emdash/api/media/file/${HERO_KEY}`;
const SEO_MEDIA_ID = '01M2DW4H4PB5X0AEC83M40GN7S';
const SOCIAL_MEDIA_ID = '01M2DW4H4PB5X0AEC83M40GN7T';
const data = { featured_image: { id: '01M2DW4H4PB5X0AEC83M40GN7R', provider: 'local', meta: { storageKey: HERO_KEY } } };
const lookup = { emdashSeoLookup: { collection: 'posts', contentId: '01POSTID', slug: 'a-post' } };

let logged: unknown[][] = [];
const realConsoleError = console.error;
const realFetch = globalThis.fetch;
beforeEach(() => {
	logged = [];
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
});
afterEach(() => {
	console.error = realConsoleError;
	globalThis.fetch = realFetch;
});

const throwingFactory = (calls: { n: number }): SocialImageClientFactory => () => {
	calls.n += 1;
	throw new TypeError('URL_SCHEME_NOT_SUPPORTED: The client does not support "file:" URLs');
};

function clientWith(execute: SocialImageQueryClient['execute']): SocialImageClientFactory {
	return () => ({ execute });
}

describe('resolveSocialImageSrcWith: a throwing client constructor never breaks rendering (#125)', () => {
	it('the real @libsql/client/web createClient throws synchronously on a file: URL (the #125 trigger)', () => {
		assert.throws(() => createClient({ url: 'file:emdash.db', authToken: 'x' }));
	});

	it('real createClient with a file: URL: resolves to the hero, never rejects, logs', async () => {
		const factory: SocialImageClientFactory = () => createClient({ url: 'file:emdash.db', authToken: 'x' });
		const src = await resolveSocialImageSrcWith(factory, data, { image: SEO_MEDIA_ID }, lookup);
		assert.equal(src, HERO_PATH);
		assert.ok(logged.some((args) => String(args[0]).includes('client creation failed')));
	});

	it('bare seo.image id + _emdash_seo lookup + social_image id: all fall back to the hero', async () => {
		const calls = { n: 0 };
		const src = await resolveSocialImageSrcWith(
			throwingFactory(calls),
			{ ...data, social_image: SOCIAL_MEDIA_ID },
			{ image: SEO_MEDIA_ID },
			lookup,
		);
		assert.equal(src, HERO_PATH);
		assert.equal(calls.n, 1, 'one client per resolve call: a failed creation is not retried by each lookup');
		assert.equal(logged.length, 1, 'the creation failure is logged once');
	});

	it('with no hero image it resolves to null rather than rejecting', async () => {
		const src = await resolveSocialImageSrcWith(throwingFactory({ n: 0 }), {}, { image: SEO_MEDIA_ID }, lookup);
		assert.equal(src, null);
	});

	it('a failed client still lets the same-origin media API resolve a bare seo.image id', async () => {
		const requested: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested.push(String(input));
			return new Response(JSON.stringify({ data: { item: { storageKey: 'seo-card.png' } } }), { status: 200 });
		}) as typeof fetch;
		const src = await resolveSocialImageSrcWith(throwingFactory({ n: 0 }), data, { image: SEO_MEDIA_ID }, {
			...lookup,
			origin: 'https://example.test/',
		});
		assert.equal(src, '/_emdash/api/media/file/seo-card.png');
		assert.deepEqual(requested, [`https://example.test/_emdash/api/media/${SEO_MEDIA_ID}`]);
	});

	it('a failing media API on top of a failed client still resolves to the hero', async () => {
		globalThis.fetch = (async () => {
			throw new Error('network down');
		}) as typeof fetch;
		const src = await resolveSocialImageSrcWith(throwingFactory({ n: 0 }), data, { image: SEO_MEDIA_ID }, {
			...lookup,
			origin: 'https://example.test',
		});
		assert.equal(src, HERO_PATH);
	});
});

describe('resolveSocialImageSrcWith: a throwing query never breaks rendering (#125)', () => {
	it('execute rejecting: resolves to the hero and logs each failed lookup', async () => {
		const src = await resolveSocialImageSrcWith(
			clientWith(async () => {
				throw new Error('SERVER_ERROR: 401 Unauthorized');
			}),
			data,
			{ image: SEO_MEDIA_ID },
			lookup,
		);
		assert.equal(src, HERO_PATH);
		const messages = logged.map((args) => String(args[0]));
		assert.ok(messages.some((m) => m.includes('Turso media lookup failed')));
		assert.ok(messages.some((m) => m.includes('_emdash_seo lookup failed')));
	});

	it('execute throwing synchronously: resolves to the hero', async () => {
		const src = await resolveSocialImageSrcWith(
			clientWith(() => {
				throw new Error('sync throw');
			}),
			data,
			{ image: SEO_MEDIA_ID },
			lookup,
		);
		assert.equal(src, HERO_PATH);
	});

	it('execute returning a malformed result: resolves to the hero', async () => {
		const src = await resolveSocialImageSrcWith(
			clientWith(async () => ({ rows: undefined as unknown as unknown[] })),
			data,
			{ image: SEO_MEDIA_ID },
			lookup,
		);
		assert.equal(src, HERO_PATH);
	});

	it('a failing seo lookup still lets social_image resolve', async () => {
		const src = await resolveSocialImageSrcWith(
			clientWith(async () => {
				throw new Error('boom');
			}),
			{ ...data, social_image: '/_emdash/api/media/file/social.png' },
			null,
			lookup,
		);
		assert.equal(src, '/_emdash/api/media/file/social.png');
	});
});

describe('resolveSocialImageSrcWith: healthy lookups are unchanged', () => {
	it('a bare seo.image media id resolves through the media table', async () => {
		const seen: string[] = [];
		const src = await resolveSocialImageSrcWith(
			clientWith(async ({ sql, args }) => {
				seen.push(sql);
				assert.deepEqual(args, [SEO_MEDIA_ID]);
				return { rows: [{ storage_key: 'og-card.png' }] };
			}),
			data,
			{ image: SEO_MEDIA_ID },
			lookup,
		);
		assert.equal(src, '/_emdash/api/media/file/og-card.png');
		assert.equal(seen.length, 1);
		assert.match(seen[0], /from media where id = \?/);
	});

	it('_emdash_seo.seo_image is used when the entry has no seo.image', async () => {
		const src = await resolveSocialImageSrcWith(
			clientWith(async ({ sql }) =>
				/from _emdash_seo where/.test(sql) ? { rows: [{ seo_image: '/_emdash/api/media/file/admin-og.png' }] } : { rows: [] },
			),
			data,
			null,
			lookup,
		);
		assert.equal(src, '/_emdash/api/media/file/admin-og.png');
		assert.equal(logged.length, 0);
	});

	it('a seo.image path needs no database and wins over everything else', async () => {
		const calls = { n: 0 };
		const src = await resolveSocialImageSrcWith(
			throwingFactory(calls),
			data,
			{ image: '/_emdash/api/media/file/seo.png' },
			lookup,
		);
		assert.equal(src, '/_emdash/api/media/file/seo.png');
		assert.equal(calls.n, 0, 'the client is created lazily, only when a lookup needs it');
	});

	it('no Turso configured (factory returns null): hero fallback, nothing logged', async () => {
		const src = await resolveSocialImageSrcWith(() => null, data, { image: SEO_MEDIA_ID }, lookup);
		assert.equal(src, HERO_PATH);
		assert.equal(logged.length, 0);
	});

	it('extractImageFieldMediaIdForLookup: bare ids only, never values that already have a file', () => {
		assert.equal(extractImageFieldMediaIdForLookup(SEO_MEDIA_ID), SEO_MEDIA_ID);
		assert.equal(extractImageFieldMediaIdForLookup({ id: SEO_MEDIA_ID }), SEO_MEDIA_ID);
		assert.equal(extractImageFieldMediaIdForLookup(JSON.stringify({ id: SEO_MEDIA_ID })), SEO_MEDIA_ID);
		assert.equal(extractImageFieldMediaIdForLookup({ id: SEO_MEDIA_ID, meta: { storageKey: 'k.png' } }), null);
		assert.equal(extractImageFieldMediaIdForLookup('/_emdash/api/media/file/k.png'), null);
		assert.equal(extractImageFieldMediaIdForLookup('[1]'), null);
		assert.equal(extractImageFieldMediaIdForLookup(''), null);
	});
});

describe('wiring (#125)', () => {
	const contentEntry = read('../src/lib/content/contentEntry.ts');

	it('contentEntry.resolveSocialImageSrc delegates to the guarded resolver with the real factory', () => {
		assert.match(
			contentEntry,
			/resolveSocialImageSrcWith\(createLibsqlClientForContentQueries, data, seo, options\)/,
		);
	});

	it('contentEntry never calls the client factory itself (only socialImage.ts does, inside try)', () => {
		assert.doesNotMatch(contentEntry, /(?<!function )createLibsqlClientForContentQueries\(\)/);
		assert.doesNotMatch(contentEntry, /\.execute\(/);
	});
});
