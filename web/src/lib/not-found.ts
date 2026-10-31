/**
 * Not-found vs server-error decisions shared by the reader routes (`[slug]`, `posts/[slug]`,
 * `archives/[slug]`) and unit-tested in `scripts/test-not-found-routes.mts`.
 *
 * Why this matters for SEO: a 404 (+ noindex) tells Google the URL is gone, a 5xx says "try
 * again later". A transient database or runtime failure must therefore never be served as a 404.
 */

/**
 * Typed not-found from Astro live collections (`astro/dist/content/loaders/errors.js`). Astro's
 * own `LiveEntryNotFoundError.is()` checks `error.name`, so we do the same (no runtime import of
 * `astro:content` here, which keeps this module unit-testable under plain Node).
 */
const LIVE_ENTRY_NOT_FOUND = 'LiveEntryNotFoundError';

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * True only for a typed "no such entry" error; every other error is a real failure (#121).
 *
 * How EmDash 1.3.1 reports a miss: `getEmDashEntry()` returns `{ entry: null }` with NO `error`.
 * Its loader returns nothing for "no row" and for a missing `ec_*` table, Astro turns that into a
 * `LiveEntryNotFoundError`, and `getEmDashEntry` swallows that typed error before returning. So in
 * practice a route sees an `error` only for a real failure: the loader wraps database / runtime
 * errors as `Failed to load entry: …`, and Astro wraps loader throws as `LiveCollectionError`.
 * The message text is never inspected: a transient error whose message happens to contain
 * "missing" or "not found" must stay a 5xx, never a noindex 404 that would de-index a live URL.
 * What this function cannot see: a missing `ec_*` table is reported as a plain miss inside
 * EmDash, and an empty database misses every slug. The routes therefore confirm the content store
 * is live before answering 404 (`content-store-guard.ts`, #128); if it is not, the answer is 503.
 */
export function isExpectedLookupMiss(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === LIVE_ENTRY_NOT_FOUND
	);
}

/**
 * What `[slug].astro` should do with its route param.
 *
 * `[slug]` only ever sees an empty slug when Astro renders an *error* through it (Astro resolves
 * an error page by matching `/404` or `/500` against the route table). With `404.astro` and
 * `500.astro` in place that should not happen, but if it does it is a server error: answering
 * 404 would turn a homepage or article outage into a noindex "gone".
 */
export type SlugParamDecision = { kind: 'lookup'; slug: string } | { kind: 'server-error' };

export function decideSlugParam(slug: string | undefined): SlugParamDecision {
	return slug ? { kind: 'lookup', slug } : { kind: 'server-error' };
}

export type EntryLookupResult = { entry: unknown | null | undefined; error?: unknown };

/**
 * Outcome of looking a slug up in one or more collections, in order.
 * - `found`: the index of the first collection that returned an entry.
 * - `server-error`: no entry, and at least one lookup failed for a reason other than a miss.
 *   `error` is the first such failure, for the route to rethrow so Astro renders
 *   `src/pages/500.astro` (#123).
 * - `not-found`: every lookup was a clean miss (`entry` null and no error, or only a typed
 *   not-found error; see {@link isExpectedLookupMiss}).
 */
export type EntryLookupOutcome =
	| { kind: 'found'; index: number }
	| { kind: 'not-found' }
	| { kind: 'server-error'; message: string; error: unknown };

export function decideEntryLookup(results: readonly EntryLookupResult[]): EntryLookupOutcome {
	let unexpected: { error: unknown } | null = null;
	for (const [index, result] of results.entries()) {
		if (result.error) {
			if (unexpected === null && !isExpectedLookupMiss(result.error)) unexpected = { error: result.error };
			continue;
		}
		if (result.entry) return { kind: 'found', index };
	}
	return unexpected === null
		? { kind: 'not-found' }
		: { kind: 'server-error', message: errorMessage(unexpected.error), error: unexpected.error };
}
