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
	resolveSocialImageWith,
	type SocialImageClientFactory,
	type SocialImageQueryClient,
} from '../src/lib/content/socialImage.ts';
import { resolveHeroImageAltFromMediaWith } from '../src/lib/content/heroImage.ts';
import { createRenderLookupBudget } from '../src/lib/content/renderLookup.ts';

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

	it('a failed client never falls back to a Worker → self HTTP fetch (#195)', async () => {
		const requested: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requested.push(String(input));
			throw new Error('must not fetch');
		}) as typeof fetch;
		const src = await resolveSocialImageSrcWith(
			throwingFactory({ n: 0 }),
			{ ...data, social_image: SOCIAL_MEDIA_ID },
			{ image: SEO_MEDIA_ID },
			lookup,
		);
		assert.equal(src, HERO_PATH);
		assert.deepEqual(requested, []);
	});
});

describe('resolveSocialImageWith: Turso lookups are bounded and logged (#195)', () => {
	it('a hung Turso costs one timeout per resolve: the rest are skipped and the hero is used', async () => {
		const warned: unknown[][] = [];
		let executes = 0;
		const started = Date.now();
		const src = await resolveSocialImageSrcWith(
			clientWith(() => {
				executes += 1;
				return new Promise<never>(() => {});
			}),
			{ ...data, social_image: SOCIAL_MEDIA_ID },
			{ image: SEO_MEDIA_ID },
			{ ...lookup, lookup: { timeoutMs: 40, log: { warn: (...args: unknown[]) => warned.push(args) } } },
		);
		assert.equal(src, HERO_PATH);
		assert.ok(Date.now() - started < 1_000, 'one timeout, not one per lookup');
		const labels = warned.map((args) => {
			assert.equal(args[0], 'ft.render.lookup_timeout');
			return (JSON.parse(String(args[1])) as { label: string }).label;
		});
		// Only the first lookup (seo.image id → media) runs; _emdash_seo and social_image are skipped.
		assert.deepEqual(labels, ['social_image.media']);
		assert.equal(executes, 1);
		assert.deepEqual(logged, [], 'timeouts / skips are not logged again as console.error');
	});

	it('one budget per page render: a hero-alt timeout skips every social-image lookup', async () => {
		const warned: unknown[][] = [];
		const log = { warn: (...args: unknown[]) => warned.push(args) };
		const budget = createRenderLookupBudget();
		let executes = 0;
		const hung = () => {
			executes += 1;
			return new Promise<never>(() => {});
		};
		const heroValue = { id: '01M2DW4H4PB5X0AEC83M40GN7R', provider: 'local', meta: { storageKey: HERO_KEY } };
		const started = Date.now();
		const alt = await resolveHeroImageAltFromMediaWith(
			() => ({ execute: hung }),
			{ featured_image: heroValue },
			'A post',
			'A post featured image',
			{ timeoutMs: 40, log, budget },
		);
		const src = await resolveSocialImageSrcWith(
			clientWith(hung),
			{ ...data, social_image: SOCIAL_MEDIA_ID },
			{ image: SEO_MEDIA_ID },
			{ ...lookup, lookup: { timeoutMs: 40, log, budget } },
		);
		assert.equal(alt, 'A post featured image');
		assert.equal(src, HERO_PATH);
		assert.ok(Date.now() - started < 1_000, 'the whole render pays one timeout');
		assert.equal(executes, 1);
		assert.equal(warned.length, 1);
		assert.match(String(warned[0][1]), /"label":"hero_alt\.media"/);
		assert.deepEqual(logged, []);
	});

	it('a shared budget bounds a concurrent request (recent posts: entries under Promise.all)', async () => {
		const timeoutMs = 200;
		const budget = createRenderLookupBudget();
		const warned: unknown[][] = [];
		let executes = 0;
		const factory = clientWith(() => {
			executes += 1;
			return new Promise<never>(() => {});
		});
		const options = {
			...lookup,
			lookup: { timeoutMs, log: { warn: (...args: unknown[]) => warned.push(args) }, budget },
		};
		const entries = 5;
		const started = Date.now();
		// Each entry has two Turso stages (seo.image id → media, then social_image id → media), like the
		// recent-posts endpoint resolving its entries concurrently.
		const srcs = await Promise.all(
			Array.from({ length: entries }, () =>
				resolveSocialImageSrcWith(factory, { ...data, social_image: SOCIAL_MEDIA_ID }, { image: SEO_MEDIA_ID }, options),
			),
		);
		const elapsed = Date.now() - started;
		assert.deepEqual(srcs, Array(entries).fill(HERO_PATH));
		assert.ok(elapsed < 2 * timeoutMs, `about one timeout of wall time, not one per stage (${elapsed} ms)`);
		// Only the lookups already in flight when the budget tripped ran (≤ one per entry); every
		// second-stage lookup was skipped.
		assert.ok(executes <= entries, `at most one Turso call per in-flight entry (${executes})`);
		assert.ok(warned.length <= entries);
		assert.ok(budget.trippedBy);
		assert.deepEqual(logged, []);
	});

	it('socialImage.ts has no fetch call', () => {
		assert.doesNotMatch(read('../src/lib/content/socialImage.ts'), /\bfetch\s*\(/);
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
		const seen: { sql: string; args: string[] }[] = [];
		const src = await resolveSocialImageSrcWith(
			clientWith(async (statement) => {
				seen.push(statement);
				return { rows: [{ storage_key: 'og-card.png' }] };
			}),
			data,
			{ image: SEO_MEDIA_ID },
			lookup,
		);
		assert.equal(src, '/_emdash/api/media/file/og-card.png');
		// Asserted after the resolve: inside execute a failure would be swallowed by the guard under test.
		assert.equal(seen.length, 1);
		assert.match(seen[0].sql, /from media where id = \?/);
		assert.deepEqual(seen[0].args, [SEO_MEDIA_ID]);
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

describe('resolveSocialImageWith reports a hero fallback (#132)', () => {
	it('a real social image is not a hero fallback', async () => {
		const image = await resolveSocialImageWith(
			() => null,
			data,
			{ image: '/_emdash/api/media/file/seo.png' },
			lookup,
		);
		assert.deepEqual(image, { src: '/_emdash/api/media/file/seo.png', fellBackToHero: false });
	});

	it('no social image uses the hero and says so', async () => {
		const image = await resolveSocialImageWith(() => null, data, null, lookup);
		assert.deepEqual(image, { src: HERO_PATH, fellBackToHero: true });
	});

	it('no social image and no hero resolves to nothing', async () => {
		const image = await resolveSocialImageWith(() => null, {}, null, lookup);
		assert.deepEqual(image, { src: null, fellBackToHero: false });
	});
});

describe('wiring (#125)', () => {
	const contentEntry = read('../src/lib/content/contentEntry.ts');

	it('contentEntry.resolveSocialImage delegates to the guarded resolver with the real factory', () => {
		assert.match(
			contentEntry,
			/resolveSocialImageWith\(createLibsqlClientForContentQueries, data, seo, options\)/,
		);
	});

	it('contentEntry never calls the client factory itself (only socialImage.ts does, inside try)', () => {
		assert.doesNotMatch(contentEntry, /(?<!function )createLibsqlClientForContentQueries\(\)/);
		assert.doesNotMatch(contentEntry, /\.execute\(/);
	});
});
