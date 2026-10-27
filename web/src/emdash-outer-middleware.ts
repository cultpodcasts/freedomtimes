/**
 * EmDash `middleware.outer` — runs BEFORE `emdash/middleware` getRuntime.
 *
 * Do not reimplement `_emdash_redirects`. Do not call
 * `emdash/internal/middleware/redirect` here. That handler's fallback is isolate-wide
 * getDb (libsql web client). On Cloudflare Workers, reusing that client
 * on a later request trips workerd's cross-request I/O guard: document
 * routes hang at 0 bytes while `/_emdash/*` (scoped db after getRuntime)
 * still answers.
 *
 * Official order stays: getRuntime (request-scoped db) →
 * `emdash/internal/middleware/redirect` → the page. This file logs [ft-mw] and
 * serves the anonymous reader page cache (lib/page-cache*.ts): a cache hit is
 * answered here, before getRuntime, so it costs no runtime init and no Turso
 * round trips. The cache is off unless PAGE_CACHE=on and SITE_ACCESS_MODE=public
 * (production only; locked staging never caches). It never touches the db.
 */
import { defineMiddleware } from 'astro:middleware';
import { env as cfEnv, waitUntil } from 'cloudflare:workers';

import { SESSION_COOKIE } from './lib/auth';
import { shouldTraceFtMwPath } from './lib/ft-mw-trace';
import { createFtMwLogger } from './lib/ft-mw-log';
import { defaultPageCache, readPageCacheEpoch } from './lib/page-cache';
import {
	decidePageCacheRequest,
	isStorableResponse,
	pageCacheKeyUrl,
	pageCacheTtlSeconds,
	type PageCacheEnv,
} from './lib/page-cache-policy';
import { recordPageView } from './lib/page-view-analytics';

const ASTRO_SESSION_COOKIE = 'astro-session';
const NEXT_HANG_WARN_MS = 3_000;

/** Original Cache-Control of a stored page (the stored copy carries the edge TTL). */
const ORIG_CACHE_CONTROL = 'x-ft-orig-cache-control';

function runInBackground(promise: Promise<unknown>): void {
	const guarded = promise.catch((error) => console.warn('[ft-page-cache] background', error));
	try {
		waitUntil(guarded);
	} catch {
		// Not on Workers (unit tests / dev): let it run detached.
	}
}

function withCacheHeader(response: Response, state: string, extraTiming?: string): Response {
	const headers = new Headers(response.headers);
	headers.set('x-ft-cache', state);
	if (extraTiming) {
		headers.set('server-timing', extraTiming);
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Anonymous reader page cache. Returns a Response on a hit; otherwise calls
 * `next()` and stores an eligible 200. Bypass reasons go in `x-ft-cache`.
 */
async function withPageCache(
	request: Request,
	url: URL,
	next: () => Promise<Response>,
	/** Astro attaches `context.cookies` Set-Cookie only after the chain; check it directly. */
	hasPendingCookies: () => boolean,
): Promise<Response> {
	const env = cfEnv as unknown as PageCacheEnv;
	const decision = decidePageCacheRequest(env, {
		method: request.method,
		pathname: url.pathname,
		search: url.search,
		cookie: request.headers.get('cookie'),
		authorization: request.headers.get('authorization'),
	});
	if (!decision.cacheable) {
		if (decision.reason === 'disabled') {
			return next();
		}
		return withCacheHeader(await next(), `BYPASS-${decision.reason}`);
	}

	const cache = defaultPageCache();
	const lookupStart = performance.now();
	const epoch = cache ? await readPageCacheEpoch() : null;
	if (!cache || epoch === null) {
		return withCacheHeader(await next(), 'BYPASS-unavailable');
	}
	const key = new Request(pageCacheKeyUrl(url.origin, epoch, decision.keyPath), { method: 'GET' });

	let hit: Response | undefined;
	try {
		hit = await cache.match(key);
	} catch (error) {
		console.warn('[ft-page-cache] match failed', error);
	}
	if (hit) {
		const lookupMs = (performance.now() - lookupStart).toFixed(1);
		const headers = new Headers(hit.headers);
		const original = headers.get(ORIG_CACHE_CONTROL);
		headers.delete(ORIG_CACHE_CONTROL);
		if (original) {
			headers.set('cache-control', original);
		} else {
			headers.delete('cache-control');
		}
		headers.set('x-ft-cache', 'HIT');
		headers.set('server-timing', `ftcache;desc="HIT";dur=${lookupMs}`);
		const response = new Response(request.method === 'HEAD' ? null : hit.body, { status: 200, headers });
		// Same aggregate analytics as an uncached render (inner middleware is skipped on a hit).
		recordPageView(request, response);
		return response;
	}

	const response = await next();
	if (request.method !== 'GET' || hasPendingCookies() || !isStorableResponse(response)) {
		return withCacheHeader(response, response.status === 200 ? 'BYPASS-response' : `BYPASS-${response.status}`);
	}

	const ttl = pageCacheTtlSeconds(env);
	const [forClient, forCache] = response.body ? response.body.tee() : [null, null];
	const storeHeaders = new Headers(response.headers);
	const original = storeHeaders.get('cache-control');
	if (original) {
		storeHeaders.set(ORIG_CACHE_CONTROL, original);
	}
	storeHeaders.set('cache-control', `public, max-age=${ttl}`);
	storeHeaders.delete('server-timing');
	runInBackground(cache.put(key, new Response(forCache, { status: 200, headers: storeHeaders })));

	const clientHeaders = new Headers(response.headers);
	clientHeaders.set('x-ft-cache', 'MISS');
	return new Response(forClient, { status: response.status, statusText: response.statusText, headers: clientHeaders });
}

export const onRequest = defineMiddleware(async (context, next) => {
	return withPageCache(
		context.request,
		context.url,
		() => tracedNext(context, next),
		() => !context.cookies.headers().next().done,
	);
});

async function tracedNext(
	context: Parameters<Parameters<typeof defineMiddleware>[0]>[0],
	next: () => Promise<Response>,
): Promise<Response> {
	const startedAt = performance.now();
	const { pathname } = context.url;
	const cfRay = context.request.headers.get('cf-ray') ?? '';
	const trace = shouldTraceFtMwPath(pathname);
	const log = createFtMwLogger({ cfRay, pathname, startedAt });

	if (trace) {
		log('enter', {
			hasAstroSession: context.cookies.get(ASTRO_SESSION_COOKIE)?.value ? 'yes' : 'no',
			hasFtSession: context.cookies.get(SESSION_COOKIE)?.value ? 'yes' : 'no',
		});
		log('redirect-check defer', {
			source: pathname,
			reason: 'official-redirect-after-runtime',
		});
		log('next-start');
		let hangTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
			log('next-hang', { waitedMs: NEXT_HANG_WARN_MS });
		}, NEXT_HANG_WARN_MS);
		try {
			const inner = await next();
			log('next-end', { status: inner.status });
			return inner;
		} finally {
			if (hangTimer !== undefined) {
				clearTimeout(hangTimer);
			}
		}
	}

	return next();
}
