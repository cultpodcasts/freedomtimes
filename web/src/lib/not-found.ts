/**
 * Not-found vs server-error decisions shared by the reader routes (`[slug]`, `posts/[slug]`,
 * `archives/[slug]`) and unit-tested in `scripts/test-not-found-routes.mts`.
 *
 * Why this matters for SEO: a 404 (+ noindex) tells Google the URL is gone, a 5xx says "try
 * again later". A transient database or runtime failure must therefore never be served as a 404.
 */

/**
 * Error messages EmDash lookups produce for a genuine miss. Substring match on the message,
 * kept in one place so the routes cannot drift. Tightening this to EmDash's typed not-found
 * result is tracked separately (PR #119 review); do not widen it.
 */
const EXPECTED_LOOKUP_MISS_SUBSTRINGS = [
	'not found',
	'no row',
	'missing',
	'no such table',
	'does not exist',
	'unknown collection',
] as const;

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** True when an EmDash lookup error means "no such entry" rather than a real failure. */
export function isExpectedLookupMiss(error: unknown): boolean {
	const lower = errorMessage(error).toLowerCase();
	return EXPECTED_LOOKUP_MISS_SUBSTRINGS.some((needle) => lower.includes(needle));
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
 * - `not-found`: every lookup was a clean miss.
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
