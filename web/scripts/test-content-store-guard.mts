/**
 * Content-store guard (#128): a Worker on an unmigrated, empty or unreachable EmDash database must
 * answer 503 + Retry-After, never a mass 404 + noindex that would de-index the site. Genuine misses
 * on a live database stay 404.
 *
 * Pure logic from src/lib/content-store-guard.ts, plus source checks that every reader route,
 * the homepage loader and the sitemaps consult the guard. The rendered 503 is covered by
 * `npm run test:worker-routes` (scripts/test-error-routes-worker.mts) after a build.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ContentStoreUnavailableError,
	createContentStoreGuard,
	diagnoseContentStore,
	isContentStoreUnavailable,
	markContentStoreUnavailable,
	promoteContentStoreUnavailable,
	REQUIRED_CONTENT_TABLES,
	rethrowLookupFailure,
	type ContentStoreProbeResult,
} from '../src/lib/content-store-guard.ts';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string) => readFileSync(join(webRoot, rel), 'utf8');

const LIVE: ContentStoreProbeResult = { tables: [...REQUIRED_CONTENT_TABLES], hasPublishedPost: true };

function countingGuard(results: (ContentStoreProbeResult | Error)[]) {
	const logs: { message: string; details: Record<string, unknown> }[] = [];
	let calls = 0;
	const guard = createContentStoreGuard(
		async () => {
			const next = results[Math.min(calls, results.length - 1)];
			calls += 1;
			if (next instanceof Error) throw next;
			return next;
		},
		(message, details) => logs.push({ message, details }),
	);
	return { guard, logs, calls: () => calls };
}

describe('diagnoseContentStore', () => {
	it('a live database (all reader tables, a published post) is healthy', () => {
		assert.equal(diagnoseContentStore(LIVE), null);
	});
	it('missing reader tables (unmigrated / wrong database) are named', () => {
		assert.match(diagnoseContentStore({ tables: [], hasPublishedPost: false }) ?? '', /missing tables ec_posts, ec_pages, ec_archives/);
		assert.match(diagnoseContentStore({ tables: ['ec_posts', 'ec_pages'], hasPublishedPost: true }) ?? '', /missing tables ec_archives\b/);
	});
	it('tables present but no published post (empty / auto-seeded database) is unavailable', () => {
		assert.match(diagnoseContentStore({ tables: [...REQUIRED_CONTENT_TABLES], hasPublishedPost: false }) ?? '', /no published posts/);
	});
});

describe('createContentStoreGuard', () => {
	it('healthy: resolves, probes once per isolate, and does not log', async () => {
		const { guard, logs, calls } = countingGuard([LIVE]);
		await guard();
		await guard();
		await guard();
		assert.equal(calls(), 1);
		assert.deepEqual(logs, []);
	});

	it('concurrent first misses share one probe (cold isolate under a burst)', async () => {
		const { guard, calls } = countingGuard([LIVE]);
		await Promise.all(Array.from({ length: 8 }, () => guard()));
		assert.equal(calls(), 1);
	});

	it('a failed shared probe rejects every waiter once and is not remembered', async () => {
		const { guard, calls, logs } = countingGuard([{ tables: [], hasPublishedPost: false }, LIVE]);
		const settled = await Promise.allSettled(Array.from({ length: 5 }, () => guard()));
		assert.ok(settled.every((s) => s.status === 'rejected' && isContentStoreUnavailable(s.reason)));
		assert.equal(calls(), 1);
		assert.equal(logs.length, 1);
		await guard();
		assert.equal(calls(), 2);
	});

	it('fresh callers do not join the shared probe', async () => {
		const { guard, calls } = countingGuard([LIVE]);
		await Promise.all([guard(), guard({ fresh: true }), guard({ fresh: true })]);
		assert.equal(calls(), 3);
	});

	it('unmigrated: throws ContentStoreUnavailableError and logs loudly', async () => {
		const { guard, logs } = countingGuard([{ tables: [], hasPublishedPost: false }]);
		await assert.rejects(guard(), (error: unknown) => {
			assert.ok(error instanceof ContentStoreUnavailableError);
			assert.ok(isContentStoreUnavailable(error));
			assert.match((error as Error).message, /missing tables/);
			return true;
		});
		assert.equal(logs.length, 1);
		assert.match(logs[0].message, /UNAVAILABLE.*503.*#128/);
	});

	it('empty database: throws ContentStoreUnavailableError', async () => {
		const { guard } = countingGuard([{ tables: [...REQUIRED_CONTENT_TABLES], hasPublishedPost: false }]);
		await assert.rejects(guard(), (error: unknown) => isContentStoreUnavailable(error));
	});

	it('unreachable: a probe that throws becomes ContentStoreUnavailableError with the cause kept', async () => {
		const down = new Error('fetch failed');
		const { guard, logs } = countingGuard([down]);
		await assert.rejects(guard(), (error: unknown) => {
			assert.ok(isContentStoreUnavailable(error));
			assert.equal((error as Error).cause, down);
			assert.match((error as Error).message, /probe failed: fetch failed/);
			return true;
		});
		assert.equal(logs.length, 1);
	});

	it('failures are never remembered: the store recovers on the next request once fixed', async () => {
		const { guard, calls } = countingGuard([{ tables: [], hasPublishedPost: false }, LIVE]);
		await assert.rejects(guard());
		await guard();
		await guard();
		assert.equal(calls(), 2, 'probe again after a failure, then remember healthy');
	});

	it('fresh: bypasses the remembered healthy result (after a lookup error)', async () => {
		const { guard, calls } = countingGuard([LIVE, new Error('fetch failed'), LIVE]);
		await guard();
		await assert.rejects(guard({ fresh: true }), (error: unknown) => isContentStoreUnavailable(error));
		assert.equal(calls(), 2);
		await guard();
		assert.equal(calls(), 3, 'a failed fresh probe clears the healthy flag');
	});
});

describe('rethrowLookupFailure', () => {
	it('healthy store: rethrows the original lookup error (500 page)', async () => {
		const original = new Error('Failed to load entry: column x');
		const { guard, calls } = countingGuard([LIVE]);
		await guard();
		await assert.rejects(rethrowLookupFailure(original, guard), (error: unknown) => error === original);
		assert.equal(calls(), 2, 'always probes fresh');
	});
	it('store down: ContentStoreUnavailableError (503 page) instead of the original error', async () => {
		const { guard } = countingGuard([new Error('fetch failed')]);
		await assert.rejects(rethrowLookupFailure(new Error('Failed to load entry'), guard), (error: unknown) => isContentStoreUnavailable(error));
	});
});

describe('isContentStoreUnavailable', () => {
	it('matches by name, directly or through a wrapping cause', () => {
		const inner = new ContentStoreUnavailableError('missing tables ec_posts');
		assert.ok(isContentStoreUnavailable(inner));
		assert.ok(isContentStoreUnavailable(new Error('LiveCollectionError', { cause: inner })));
		assert.ok(isContentStoreUnavailable({ name: 'ContentStoreUnavailableError' }));
	});
	it('other errors and non-errors are not a down store (they stay 500)', () => {
		for (const value of [new Error('fetch failed'), new Error('EmDash content store unavailable'), null, undefined, 'ContentStoreUnavailableError', {}]) {
			assert.equal(isContentStoreUnavailable(value), false, String(value));
		}
	});
});

describe('promoteContentStoreUnavailable (500.astro → 503)', () => {
	const flagged = () => {
		const locals = {};
		markContentStoreUnavailable(locals);
		return locals;
	};
	it('a 500 on a flagged request becomes a 503 with the same body, Retry-After and no-store', async () => {
		const page = new Response('<p>down</p>', {
			status: 500,
			headers: { 'content-type': 'text/html', 'retry-after': '300', 'cache-control': 'no-store', 'x-other': 'kept' },
		});
		const r = promoteContentStoreUnavailable(page, flagged());
		assert.equal(r.status, 503);
		assert.equal(r.headers.get('retry-after'), '300');
		assert.equal(r.headers.get('cache-control'), 'no-store');
		assert.equal(r.headers.get('x-other'), 'kept');
		assert.equal(r.headers.get('content-type'), 'text/html');
		assert.equal(await r.text(), '<p>down</p>');
	});
	it('a flagged 500 without Retry-After still gets one', () => {
		const r = promoteContentStoreUnavailable(new Response('x', { status: 500 }), flagged());
		assert.equal(r.status, 503);
		assert.equal(r.headers.get('retry-after'), '300');
	});
	it('unflagged requests and non-500s are returned untouched (the same object)', () => {
		for (const [res, locals] of [
			[new Response('x', { status: 500 }), {}],
			[new Response('x', { status: 404 }), flagged()],
			[new Response('x', { status: 200 }), flagged()],
		] as const) {
			assert.equal(promoteContentStoreUnavailable(res, locals), res);
		}
	});
	it('src/middleware.ts wraps every return path with it', () => {
		assert.match(read('src/middleware.ts'), /export const onRequest = defineMiddleware\(async \(context, next\) => \{\s*return promoteContentStoreUnavailable\(await handleSiteRequest\(context, next\), context\.locals\);\s*\}\);/);
	});
});

describe('routes consult the guard before a 404 or an empty answer', () => {
	it('[slug], posts/[slug], archives/[slug]: assertContentStoreReady() right before setting the 404', () => {
		for (const file of ['src/pages/[slug].astro', 'src/pages/posts/[slug].astro', 'src/pages/archives/[slug].astro']) {
			const page = read(file);
			assert.match(page, /import \{ assertContentStoreReady \} from '[./]+lib\/content-store-guard-db';/, file);
			assert.match(page, /await assertContentStoreReady\(\);\s*notFound = true;/, `${file}: guard before the miss 404`);
		}
	});
	it('homepage loader: guard on a failed light query, a failed fallback and an empty list', () => {
		const loader = read('src/lib/content/homepage-entries.ts');
		assert.match(loader, /catch \(error\) \{[\s\S]*?await assertContentStoreReady\(\{ fresh: true \}\);/);
		assert.match(loader, /if \(collection\.error\) await rethrowLookupFailure\(collection\.error, assertContentStoreReady\);/);
		assert.match(loader, /if \(entries\.length === 0\) await assertContentStoreReady\(\);/);
	});
	it('sitemaps: the site sitemap and the public EmDash sitemaps check the store before generating', () => {
		assert.match(read('src/lib/site-sitemap-db.ts'), /generateSiteSitemapXml[\s\S]*?\{\s*\/\/[^\n]*\n\s*await assertContentStoreReady\(\);/);
		assert.match(read('src/middleware.ts'), /generate: sitemapLocked \? \(\) => next\(\) : async \(\) => \{\s*await assertContentStoreReady\(\);\s*return next\(\);/);
	});
	it('the database probe only reads (sqlite_master and one ec_posts row)', () => {
		const probe = read('src/lib/content-store-guard-db.ts');
		assert.match(probe, /FROM sqlite_master/);
		assert.match(probe, /LIMIT 1/);
		assert.doesNotMatch(probe, /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/);
	});
});
