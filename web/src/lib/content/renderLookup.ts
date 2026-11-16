/**
 * Bounded, timed lookups for the article / archive render path (#195).
 *
 * `EmDashContentView` awaits the hero-alt and social-image lookups in component frontmatter, after
 * the 200 headers are sent. Anything slow there holds the whole reader page (and the page-cache
 * fill) hostage. #195: a Worker → own-hostname `fetch` in that path waited ~20 s on every uncached
 * render (Cloudflare 522 after its 19 s TCP connect timeout) and logged nothing.
 *
 * {@link timedRenderLookup} caps one lookup with a short timeout (it rejects with
 * {@link RenderLookupTimeoutError}; callers already catch and fall back) and logs one
 * `ft.render.slow_lookup` / `ft.render.lookup_timeout` line so a slow external call shows up in
 * Workers Logs next time. Pure and runtime-free so `scripts/test-render-lookup.mts` can drive it.
 */

/** Per-lookup cap for render-path Turso reads. Normal reads are tens of milliseconds. */
export const RENDER_LOOKUP_TIMEOUT_MS = 2_500;
/** A lookup at or above this is logged as slow even when it succeeds. */
export const RENDER_LOOKUP_SLOW_MS = 750;

export const RENDER_SLOW_LOOKUP_LOG = 'ft.render.slow_lookup';
export const RENDER_LOOKUP_TIMEOUT_LOG = 'ft.render.lookup_timeout';

export class RenderLookupTimeoutError extends Error {
	constructor(label: string, timeoutMs: number) {
		super(`${label} timed out after ${timeoutMs} ms`);
		this.name = 'RenderLookupTimeoutError';
	}
}

export type RenderLookupOptions = {
	timeoutMs?: number;
	slowMs?: number;
	log?: { warn: (...args: unknown[]) => void };
	now?: () => number;
};

/**
 * Runs `run()` with a timeout. Resolves or rejects like `run()`, or rejects with
 * {@link RenderLookupTimeoutError} once `timeoutMs` passes (the underlying promise is abandoned).
 */
export async function timedRenderLookup<T>(
	label: string,
	run: () => Promise<T>,
	options: RenderLookupOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? RENDER_LOOKUP_TIMEOUT_MS;
	const slowMs = options.slowMs ?? RENDER_LOOKUP_SLOW_MS;
	const log = options.log ?? console;
	const now = options.now ?? (() => Date.now());
	const started = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new RenderLookupTimeoutError(label, timeoutMs)), timeoutMs);
	});
	let outcome: 'ok' | 'error' | 'timeout' = 'ok';
	try {
		return await Promise.race([run(), timeout]);
	} catch (err) {
		outcome = err instanceof RenderLookupTimeoutError ? 'timeout' : 'error';
		throw err;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		const ms = now() - started;
		if (outcome === 'timeout') {
			log.warn(RENDER_LOOKUP_TIMEOUT_LOG, JSON.stringify({ label, ms, timeoutMs }));
		} else if (ms >= slowMs) {
			log.warn(RENDER_SLOW_LOOKUP_LOG, JSON.stringify({ label, ms, outcome }));
		}
	}
}
