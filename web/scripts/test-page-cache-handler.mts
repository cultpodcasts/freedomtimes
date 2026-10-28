/**
 * Behavioural tests for the anonymous reader page cache handler and the
 * purge plugin hooks, driven with an in-memory Cache fake (no Workers runtime).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ORIG_CACHE_CONTROL_HEADER, handlePageCache, type PageCacheDeps } from '../src/lib/page-cache-handler.ts';
import { PAGE_CACHE_MAX_STORE_BYTES, pageCacheKeyUrl } from '../src/lib/page-cache-policy.ts';
import { createPurgeHooks } from '../src/plugins/page-cache-purge-hooks.ts';

const ORIGIN = 'https://freedomtimes.news';
const PROD = { PAGE_CACHE: 'on', PAGE_CACHE_TTL_SECONDS: '120', SITE_ACCESS_MODE: 'public' };
const PAGE = '<!DOCTYPE html><html><body><p>page</p></body></html>\n';
const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate' };

class FakeCache {
	store = new Map<string, Response>();
	matches: string[] = [];
	async match(request: Request): Promise<Response | undefined> {
		this.matches.push(request.url);
		const hit = this.store.get(request.url);
		return hit ? hit.clone() : undefined;
	}
	async put(request: Request, response: Response): Promise<void> {
		// Like the Workers Cache API: consumes the body.
		const body = await response.arrayBuffer();
		this.store.set(request.url, new Response(body, { status: response.status, headers: response.headers }));
	}
}

function harness(over: Partial<PageCacheDeps> = {}) {
	const cache = new FakeCache();
	const background: Promise<unknown>[] = [];
	const pageViews: { path: string; state: string | null }[] = [];
	const deps: PageCacheDeps = {
		env: PROD,
		cache,
		readEpoch: async () => 'e1',
		waitUntil: (p) => {
			background.push(p);
		},
		recordPageView: (request, response) => {
			pageViews.push({ path: new URL(request.url).pathname, state: response.headers.get('x-ft-cache') });
		},
		...over,
	};
	let renders = 0;
	const run = async (
		path: string,
		{
			method = 'GET',
			headers = {} as Record<string, string>,
			response = () => new Response(PAGE, { status: 200, headers: HTML }),
			pendingCookies = false,
		} = {},
	) => {
		const url = new URL(path, ORIGIN);
		const request = new Request(url, { method, headers });
		const res = await handlePageCache(deps, {
			request,
			url,
			next: async () => {
				renders += 1;
				return response();
			},
			hasPendingCookies: () => pendingCookies,
		});
		await Promise.all(background.splice(0));
		return res;
	};
	return { cache, deps, run, pageViews, renders: () => renders };
}

const key = (path: string, epoch = 'e1') => pageCacheKeyUrl(ORIGIN, epoch, path);

describe('page cache handler: MISS → store → HIT', () => {
	it('stores an eligible 200 with the edge TTL and the original Cache-Control preserved', async () => {
		const h = harness();
		const miss = await h.run('/archives');
		assert.equal(miss.headers.get('x-ft-cache'), 'MISS');
		assert.equal(miss.headers.get('cache-control'), HTML['cache-control']);
		assert.equal(await miss.text(), PAGE);
		const stored = h.cache.store.get(key('/archives'));
		assert.ok(stored, 'stored under the epoch key');
		assert.equal(stored.headers.get('cache-control'), 'public, max-age=120');
		assert.equal(stored.headers.get(ORIG_CACHE_CONTROL_HEADER), HTML['cache-control']);
		assert.equal(stored.headers.has('server-timing'), false);
	});

	it('HIT restores the original Cache-Control, skips render and records a page view', async () => {
		const h = harness();
		await h.run('/posts/a');
		const hit = await h.run('/posts/a');
		assert.equal(h.renders(), 1, 'second request served without next()');
		assert.equal(hit.headers.get('x-ft-cache'), 'HIT');
		assert.equal(hit.headers.get('cache-control'), HTML['cache-control']);
		assert.equal(hit.headers.has(ORIG_CACHE_CONTROL_HEADER), false);
		assert.match(hit.headers.get('server-timing') ?? '', /^ftcache;desc="HIT";dur=/);
		assert.equal(await hit.text(), PAGE);
		assert.deepEqual(h.pageViews, [{ path: '/posts/a', state: 'HIT' }]);
	});

	it('HEAD on a HIT returns headers with a null body; HEAD on a MISS is not stored', async () => {
		const h = harness();
		const headMiss = await h.run('/', { method: 'HEAD' });
		assert.equal(headMiss.headers.get('x-ft-cache'), 'BYPASS-response');
		assert.equal(h.cache.store.size, 0);
		await h.run('/');
		const headHit = await h.run('/', { method: 'HEAD' });
		assert.equal(headHit.headers.get('x-ft-cache'), 'HIT');
		assert.equal(headHit.body, null);
	});

	it('a new epoch misses (purge)', async () => {
		let epoch = 'e1';
		const h = harness({ readEpoch: async () => epoch });
		await h.run('/');
		epoch = 'e2';
		const after = await h.run('/');
		assert.equal(after.headers.get('x-ft-cache'), 'MISS');
		assert.equal(h.renders(), 2);
	});
});

describe('page cache handler: never stores unsafe responses', () => {
	const cases: [string, () => Response, boolean?][] = [
		['Set-Cookie header', () => new Response('x', { status: 200, headers: { ...HTML, 'set-cookie': 'a=b' } })],
		['Cache-Control private', () => new Response('x', { status: 200, headers: { ...HTML, 'cache-control': 'private' } })],
		['404', () => new Response('x', { status: 404, headers: HTML })],
		['302 redirect', () => new Response(null, { status: 302, headers: { location: '/x' } })],
		['JSON', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })],
		['pending Astro.cookies', () => new Response('x', { status: 200, headers: HTML }), true],
	];
	for (const [name, response, pendingCookies] of cases) {
		it(name, async () => {
			const h = harness();
			const res = await h.run('/posts/a', { response, pendingCookies: pendingCookies ?? false });
			assert.match(res.headers.get('x-ft-cache') ?? '', /^BYPASS-/);
			assert.equal(h.cache.store.size, 0);
		});
	}
});

/** A body that sends `chunks`, then errors (a render that failed after the 200 headers). */
function failingBody(chunks: string[], error = new Error('Failed to load collection: Network connection lost.')) {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.error(error);
		},
	});
}

describe('page cache handler: never stores empty or cut-off pages (#123)', () => {
	const cases: [string, () => Response][] = [
		['empty 200 body', () => new Response('', { status: 200, headers: HTML })],
		['null 200 body', () => new Response(null, { status: 200, headers: HTML })],
		['HTML cut off before </html>', () => new Response('<!DOCTYPE html><html><head><title>Freedom Times</title></head><body><main>', { status: 200, headers: HTML })],
		['stream errors after the 200 headers', () => new Response(failingBody(['<!DOCTYPE html><html><head>']), { status: 200, headers: HTML })],
		['stream errors before any byte', () => new Response(failingBody([]), { status: 200, headers: HTML })],
		['500 page', () => new Response(PAGE, { status: 500, headers: { ...HTML, 'cache-control': 'no-store' } })],
		['503', () => new Response(PAGE, { status: 503, headers: HTML })],
	];
	for (const [name, response] of cases) {
		it(`${name}: not stored, next request renders again`, async () => {
			const h = harness();
			const first = await h.run('/', { response });
			assert.notEqual(first.headers.get('x-ft-cache'), 'HIT');
			await first.text().catch(() => undefined);
			assert.equal(h.cache.store.size, 0, 'nothing stored');
			const second = await h.run('/', { response });
			assert.notEqual(second.headers.get('x-ft-cache'), 'HIT');
			await second.text().catch(() => undefined);
			assert.equal(h.renders(), 2, 'the failure is never served from cache');
		});
	}

	it('a DB failure on / is a 5xx with no-store and is not cached; the recovered / then caches MISS → HIT', async () => {
		const h = harness();
		let dbUp = false;
		const response = () =>
			dbUp
				? new Response(PAGE, { status: 200, headers: HTML })
				: new Response('<!DOCTYPE html><html><body data-ft-server-error></body></html>', {
						status: 500,
						headers: { ...HTML, 'cache-control': 'no-store' },
					});
		const down = await h.run('/', { response });
		assert.equal(down.status, 500);
		assert.equal(down.headers.get('cache-control'), 'no-store');
		assert.equal(down.headers.get('x-ft-cache'), 'BYPASS-500');
		assert.equal(h.cache.store.size, 0);
		dbUp = true;
		const miss = await h.run('/', { response });
		assert.equal(miss.headers.get('x-ft-cache'), 'MISS');
		assert.equal(await miss.text(), PAGE);
		const hit = await h.run('/', { response });
		assert.equal(hit.headers.get('x-ft-cache'), 'HIT');
		assert.equal(await hit.text(), PAGE);
		assert.equal(h.renders(), 2);
	});

	it('the client still gets the streamed body on a MISS (no extra buffering for readers)', async () => {
		const h = harness();
		const miss = await h.run('/posts/a', {
			response: () => new Response(failingBody(['<!DOCTYPE html><html>']), { status: 200, headers: HTML }),
		});
		assert.equal(miss.status, 200, 'headers were already sent when the render failed');
		await assert.rejects(miss.text(), /Network connection lost/);
		assert.equal(h.cache.store.size, 0);
	});

	/** A complete HTML page of exactly `size` bytes, streamed in 64 KB chunks. */
	function htmlOfSize(size: number) {
		const head = '<!DOCTYPE html><html><body>';
		const tail = '</body></html>\n';
		const page = head + 'x'.repeat(size - head.length - tail.length) + tail;
		const bytes = new TextEncoder().encode(page);
		const step = 64 * 1024;
		return {
			page,
			response: () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							for (let i = 0; i < bytes.byteLength; i += step) controller.enqueue(bytes.slice(i, i + step));
							controller.close();
						},
					}),
					{ status: 200, headers: HTML },
				),
		};
	}

	it('a body over PAGE_CACHE_MAX_STORE_BYTES is not stored; the client still gets the full body', async () => {
		const h = harness();
		const big = htmlOfSize(PAGE_CACHE_MAX_STORE_BYTES + 1);
		const miss = await h.run('/posts/huge', { response: big.response });
		assert.equal(miss.headers.get('x-ft-cache'), 'MISS');
		const body = await miss.text();
		assert.equal(body.length, big.page.length, 'client body is complete');
		assert.equal(body, big.page);
		assert.equal(h.cache.store.size, 0, 'oversized body not stored');
	});

	it('a complete body of exactly PAGE_CACHE_MAX_STORE_BYTES is stored (the cap is inclusive)', async () => {
		const h = harness();
		const edge = htmlOfSize(PAGE_CACHE_MAX_STORE_BYTES);
		const miss = await h.run('/posts/edge', { response: edge.response });
		assert.equal(await miss.text(), edge.page);
		assert.equal(h.cache.store.size, 1);
		const hit = await h.run('/posts/edge', { response: edge.response });
		assert.equal(hit.headers.get('x-ft-cache'), 'HIT');
		assert.equal(await hit.text(), edge.page);
	});

	it('a complete text/plain body (robots.txt) is stored; an empty one is not', async () => {
		const h = harness();
		const text = { 'content-type': 'text/plain; charset=utf-8' };
		await h.run('/robots.txt', { response: () => new Response('', { status: 200, headers: text }) });
		assert.equal(h.cache.store.size, 0);
		await h.run('/robots.txt', { response: () => new Response('User-agent: *\n', { status: 200, headers: text }) });
		assert.equal(h.cache.store.size, 1);
	});
});

describe('page cache handler: request bypass', () => {
	it('query strings (including utm_*) are never looked up and never stored under the bare path', async () => {
		const h = harness();
		const res = await h.run('/archives?utm_source=x', {
			response: () => new Response('<link rel=canonical href="/archives?utm_source=x">', { status: 200, headers: HTML }),
		});
		assert.equal(res.headers.get('x-ft-cache'), 'BYPASS-query');
		assert.equal(h.cache.matches.length, 0);
		assert.equal(h.cache.store.has(key('/archives')), false);
		assert.equal(h.cache.store.size, 0);
		const bare = await h.run('/archives');
		assert.equal(bare.headers.get('x-ft-cache'), 'MISS');
		assert.doesNotMatch(await bare.text(), /utm_source/);
	});

	it('session cookies and Authorization bypass with a reason header', async () => {
		const h = harness();
		await h.run('/');
		const cookie = await h.run('/', { headers: { cookie: 'astro-session=abc' } });
		assert.equal(cookie.headers.get('x-ft-cache'), 'BYPASS-cookie');
		const auth = await h.run('/', { headers: { authorization: 'Bearer x' } });
		assert.equal(auth.headers.get('x-ft-cache'), 'BYPASS-authorization');
		assert.equal(h.renders(), 3, 'signed-in requests always render');
	});

	it('no cache or no epoch (KV unavailable) → BYPASS-unavailable, nothing stored', async () => {
		const noCache = harness({ cache: null });
		assert.equal((await noCache.run('/')).headers.get('x-ft-cache'), 'BYPASS-unavailable');
		const noEpoch = harness({ readEpoch: async () => null });
		assert.equal((await noEpoch.run('/')).headers.get('x-ft-cache'), 'BYPASS-unavailable');
		assert.equal(noEpoch.cache.store.size, 0);
		const throws = harness({
			readEpoch: async () => {
				throw new Error('kv down');
			},
		});
		assert.equal((await throws.run('/')).headers.get('x-ft-cache'), 'BYPASS-unavailable');
	});

	it('non-reader paths, non-GET and disabled cache return next() untouched (same Response object)', async () => {
		for (const [deps, path, method] of [
			[{}, '/_emdash/api/mcp', 'POST'],
			[{}, '/_emdash/admin', 'GET'],
			[{}, '/api/version.json', 'GET'],
			[{}, '/posts/a', 'POST'],
			[{ env: { ...PROD, SITE_ACCESS_MODE: 'locked' } }, '/', 'GET'],
		] as [Partial<PageCacheDeps>, string, string][]) {
			const original = new Response(PAGE, { status: 200, headers: HTML });
			const h = harness(deps);
			const res = await h.run(path, { method, response: () => original });
			assert.equal(res, original, `${method} ${path}`);
			assert.equal(res.headers.has('x-ft-cache'), false);
			assert.equal(h.cache.matches.length, 0);
		}
	});
});

describe('page cache purge plugin hooks', () => {
	const setup = (enabled = true) => {
		const bumps: string[] = [];
		const hooks = createPurgeHooks({ isEnabled: () => enabled, bump: async (r) => void bumps.push(r) });
		return { hooks, bumps };
	};

	it('draft save is a no-op; published save bumps', async () => {
		const { hooks, bumps } = setup();
		await hooks.afterSave({ collection: 'posts', content: { status: 'draft' } });
		await hooks.afterSave({ collection: 'posts', content: null });
		assert.deepEqual(bumps, []);
		await hooks.afterSave({ collection: 'posts', content: { status: 'published' } });
		assert.deepEqual(bumps, ['afterSave:posts']);
	});

	it('publish, unpublish, delete and restore bump', async () => {
		const { hooks, bumps } = setup();
		await hooks.afterPublish({ collection: 'posts' });
		await hooks.afterUnpublish({ collection: 'pages' });
		await hooks.afterDelete({ collection: 'posts' });
		await hooks.afterRestore({ collection: 'posts' });
		assert.deepEqual(bumps, ['afterPublish:posts', 'afterUnpublish:pages', 'afterDelete:posts', 'afterRestore:posts']);
	});

	it('disabled cache (staging) never bumps', async () => {
		const { hooks, bumps } = setup(false);
		await hooks.afterSave({ collection: 'posts', content: { status: 'published' } });
		await hooks.afterPublish({ collection: 'posts' });
		await hooks.afterDelete({ collection: 'posts' });
		assert.deepEqual(bumps, []);
	});
});
