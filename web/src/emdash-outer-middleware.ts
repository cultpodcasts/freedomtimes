/**
 * EmDash `middleware.outer` — runs BEFORE `emdash/middleware` getRuntime.
 *
 * Do not reimplement `_emdash_redirects`. Do not call
 * `emdash/middleware/redirect` here. That handler's fallback is isolate-wide
 * getDb (libsql web client). On Cloudflare Workers, reusing that client
 * on a later request trips workerd's cross-request I/O guard: document
 * routes hang at 0 bytes while `/_emdash/*` (scoped db after getRuntime)
 * still answers.
 *
 * Official order stays: getRuntime (request-scoped db) →
 * `emdash/middleware/redirect` → the page. This file only logs [ft-mw].
 */
import { defineMiddleware } from 'astro:middleware';

import { SESSION_COOKIE } from './lib/auth';
import { shouldTraceFtMwPath } from './lib/ft-mw-trace';
import { createFtMwLogger } from './lib/ft-mw-log';

const ASTRO_SESSION_COOKIE = 'astro-session';
const NEXT_HANG_WARN_MS = 3_000;

export const onRequest = defineMiddleware(async (context, next) => {
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
});
