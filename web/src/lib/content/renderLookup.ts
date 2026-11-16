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
 * Workers Logs next time.
 *
 * A {@link RenderLookupBudget} caps the **whole render**, not each lookup: the first timeout trips
 * it, and every later lookup that shares the budget rejects at once with
 * {@link RenderLookupSkippedError} without running. One budget per page render (hero alt + social
 * image) or per API request (recent posts, share panel) means a hung Turso costs at most one
 * timeout there, and the callers fall back (generic alt, hero OG image).
 *
 * ```mermaid
 * flowchart LR
 *   L1[lookup 1] -- ok --> L2[lookup 2] -- ok --> Done[render]
 *   L1 -- timeout 2.5 s --> Trip[budget tripped]
 *   Trip --> S2[lookup 2: skipped, no Turso call] --> FB[fallbacks: generic alt / hero OG image] --> Done
 * ```
 *
 * Pure and runtime-free so `scripts/test-render-lookup.mts` can drive it.
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

/** A lookup that did not run because an earlier lookup sharing its budget already timed out. */
export class RenderLookupSkippedError extends Error {
	constructor(label: string, trippedBy: string) {
		super(`${label} skipped: render lookup budget tripped by ${trippedBy}`);
		this.name = 'RenderLookupSkippedError';
	}
}

/**
 * True for the expected, already-logged outcomes of a bounded lookup (timeout or skip). Callers
 * fall back quietly on these and keep `console.error` for real query / client failures.
 */
export function isRenderLookupBoundError(err: unknown): boolean {
	return err instanceof RenderLookupTimeoutError || err instanceof RenderLookupSkippedError;
}

/** Shared by every lookup in one render or request. Tripped by the first timeout. */
export type RenderLookupBudget = {
	/** Label of the lookup that timed out, or `null` while the budget is intact. */
	readonly trippedBy: string | null;
	trip(label: string): void;
};

export function createRenderLookupBudget(): RenderLookupBudget {
	let trippedBy: string | null = null;
	return {
		get trippedBy() {
			return trippedBy;
		},
		trip(label: string) {
			trippedBy ??= label;
		},
	};
}

export type RenderLookupOptions = {
	timeoutMs?: number;
	slowMs?: number;
	log?: { warn: (...args: unknown[]) => void };
	now?: () => number;
	/** Share one budget across a render / request so a hung store costs at most one timeout. */
	budget?: RenderLookupBudget;
};

/**
 * Runs `run()` with a timeout. Resolves or rejects like `run()`, or rejects with
 * {@link RenderLookupTimeoutError} once `timeoutMs` passes and trips `options.budget`. When the
 * budget is already tripped it rejects with {@link RenderLookupSkippedError} and never calls `run`.
 *
 * On timeout the underlying libsql request is **not cancelled**: `@libsql/client` (0.18, web)
 * `execute()` takes no `AbortSignal`, and the only hook is the client-wide `fetch`. The abandoned
 * subrequest stays in flight until it settles or the invocation ends. That is acceptable because
 * the shared budget allows at most **one** abandoned request per render or request (later lookups
 * are skipped), so it cannot pile up against the subrequest / connection limits. The race attaches
 * a handler, so its late rejection is not unhandled.
 */
export async function timedRenderLookup<T>(
	label: string,
	run: () => Promise<T>,
	options: RenderLookupOptions = {},
): Promise<T> {
	const budget = options.budget;
	if (budget?.trippedBy) throw new RenderLookupSkippedError(label, budget.trippedBy);

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
		if (outcome === 'timeout') budget?.trip(label);
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