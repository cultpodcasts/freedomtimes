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
 * serves the anonymous reader page cache (lib/page-cache-handler.ts, wired
 * here with the Workers Cache API + KV epoch): a cache hit is
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
import { handlePageCache, type PageCacheDeps } from './lib/page-cache-handler';
import type { PageCacheEnv } from './lib/page-cache-policy';
import { recordPageView } from './lib/page-view-analytics';

const ASTRO_SESSION_COOKIE = 'astro-session';
const NEXT_HANG_WARN_MS = 3_000;

function runInBackground(promise: Promise<unknown>): void {
	try {
		waitUntil(promise);
	} catch {
		// Not on Workers (dev without the runtime): let it run detached.
	}
}

function pageCacheDeps(): PageCacheDeps {
	return {
		env: cfEnv as unknown as PageCacheEnv,
		cache: defaultPageCache(),
		readEpoch: () => readPageCacheEpoch(),
		waitUntil: runInBackground,
		recordPageView,
	};
}

export const onRequest = defineMiddleware(async (context, next) => {
	return handlePageCache(pageCacheDeps(), {
		request: context.request,
		url: context.url,
		next: () => tracedNext(context, next),
		hasPendingCookies: () => !context.cookies.headers().next().done,
	});
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
