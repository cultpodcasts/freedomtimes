/**
 * EmDash `middleware.outer` — runs BEFORE `emdash/middleware` getRuntime.
 *
 * Do not reimplement `_emdash_redirects`. EmDash already has
 * `emdash/middleware/redirect` (getDb + exact/pattern rules). The package
 * registers that module *after* runtime init, so signed-in `astro-session`
 * requests await resolveSessionUser + getRuntime first and can wedge the isolate.
 *
 * This file only reorders: run EmDash's own redirect handler first, log [ft-mw],
 * then `next()` into getRuntime when there is no editorial 302.
 */
import { defineMiddleware } from 'astro:middleware';
import { onRequest as emdashRedirect } from 'emdash/middleware/redirect';

import { SESSION_COOKIE } from './lib/auth';
import { isHttpRedirectStatus, shouldTraceFtMwPath } from './lib/emdash-exact-redirect';
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
		log('redirect-check start', { source: pathname });
	}

	let calledNext = false;
	const response = await emdashRedirect(context, async () => {
		calledNext = true;
		if (trace) {
			log('redirect-check miss', { source: pathname });
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

	if (trace && !calledNext) {
		const destination = response.headers.get('location') ?? '';
		if (isHttpRedirectStatus(response.status)) {
			log('redirect-check hit', {
				source: pathname,
				destination,
				type: response.status,
			});
			log('redirect-return', {
				status: response.status,
				source: pathname,
				destination,
			});
		} else {
			log('redirect-check miss', {
				source: pathname,
				status: response.status,
			});
		}
	}

	return response;
});
