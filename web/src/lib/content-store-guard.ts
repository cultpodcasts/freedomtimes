/**
 * Content-store guard (#128): tells a genuine 404 apart from a Worker whose EmDash database is
 * unmigrated, wrong-but-empty, or unreachable.
 *
 * Why: EmDash treats a missing `ec_*` table as "no entry" (`loadEntry` swallows
 * `isMissingTableError`) and a collection list on it as `{ entries: [] }`. A fresh-but-migrated
 * database is auto-seeded with empty `ec_*` tables on its first request. Either way every article,
 * page and archive URL would answer 404 + noindex and the homepage a 200 with no posts, which is
 * how Google de-indexes the whole site. EmDash's own runtime already answers 503 when core
 * migrations are pending; this guard covers what it cannot see.
 *
 * How: before a reader route commits to a 404 (or the homepage / site sitemap to "no content"),
 * it asks the guard whether the content store looks like a live Freedom Times database:
 *   1. the reader tables (`ec_posts`, `ec_pages`, `ec_archives`) exist, and
 *   2. `ec_posts` has at least one published, non-deleted row.
 * If not, or if the probe itself fails, the guard throws {@link ContentStoreUnavailableError};
 * `src/pages/500.astro` renders that (with no robots meta) and `src/middleware.ts` sends it as
 * HTTP 503 + `Retry-After`, `no-store` ({@link promoteContentStoreUnavailable}), so Google keeps
 * the URL and retries instead of dropping it. Each failure is logged loudly.
 *
 * Cost: a healthy result is remembered for the life of the isolate, so a healthy site probes once
 * per isolate, and only on its first miss. Failures are never remembered: the next miss probes
 * again, so the site recovers as soon as the database is fixed. After a lookup *error* (not a miss)
 * the route forces a fresh probe to decide between 503 (store down) and 500 (anything else).
 *
 * Pure and runtime-free (unit-tested in `scripts/test-content-store-guard.mts`); the database
 * probe lives in `content-store-guard-db.ts`.
 */
import { errorMessage } from './not-found';

/** Seconds a crawler should wait before retrying a 503 from this guard. */
export const CONTENT_STORE_RETRY_AFTER_SECONDS = 300;

/** Reader collections every Freedom Times database must have. */
export const REQUIRED_CONTENT_TABLES = ['ec_posts', 'ec_pages', 'ec_archives'] as const;

const UNAVAILABLE_ERROR_NAME = 'ContentStoreUnavailableError';

/** What the database probe reports. */
export type ContentStoreProbeResult = {
	/** Which of {@link REQUIRED_CONTENT_TABLES} exist. */
	tables: readonly string[];
	/** Whether `ec_posts` has at least one published, non-deleted row. */
	hasPublishedPost: boolean;
};

export type ContentStoreProbe = () => Promise<ContentStoreProbeResult>;

export type ContentStoreGuardOptions = {
	/**
	 * Bypass the remembered healthy result. Use after a lookup *error*: the database may have gone
	 * away since the isolate last saw it healthy.
	 */
	fresh?: boolean;
};

export type AssertContentStoreReady = (options?: ContentStoreGuardOptions) => Promise<void>;

/** The content store is not serving real content; the response must be a 503, never a 404. */
export class ContentStoreUnavailableError extends Error {
	readonly reason: string;

	constructor(reason: string, options?: { cause?: unknown }) {
		super(`EmDash content store unavailable: ${reason}`, options);
		this.name = UNAVAILABLE_ERROR_NAME;
		this.reason = reason;
	}
}

/**
 * True for a {@link ContentStoreUnavailableError}, also when Astro or EmDash wrapped it (checked by
 * `name` along the `cause` chain, like `isExpectedLookupMiss`, so no `instanceof` across bundles).
 */
export function isContentStoreUnavailable(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
		if ((current as { name?: unknown }).name === UNAVAILABLE_ERROR_NAME) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/** Why a probe result is not a live database, or `null` when it is. */
export function diagnoseContentStore(result: ContentStoreProbeResult): string | null {
	const missing = REQUIRED_CONTENT_TABLES.filter((table) => !result.tables.includes(table));
	if (missing.length > 0) return `missing tables ${missing.join(', ')} (unmigrated or wrong database)`;
	if (!result.hasPublishedPost) return 'ec_posts has no published posts (empty or wrong database)';
	return null;
}

/**
 * Builds the guard around a probe. Call it once per isolate (module scope) so the healthy result
 * is shared by every request the isolate serves.
 */
export function createContentStoreGuard(
	probe: ContentStoreProbe,
	log: (message: string, details: Record<string, unknown>) => void = (message, details) =>
		console.error(message, JSON.stringify(details)),
): AssertContentStoreReady {
	let healthy = false;
	return async function assertContentStoreReady(options: ContentStoreGuardOptions = {}): Promise<void> {
		if (healthy && !options.fresh) return;
		let result: ContentStoreProbeResult;
		try {
			result = await probe();
		} catch (error) {
			healthy = false;
			const reason = `probe failed: ${errorMessage(error)}`;
			log('[ft-content-store] UNAVAILABLE: serving 503, not 404 (#128)', { reason });
			throw new ContentStoreUnavailableError(reason, { cause: error });
		}
		const problem = diagnoseContentStore(result);
		if (problem) {
			healthy = false;
			log('[ft-content-store] UNAVAILABLE: serving 503, not 404 (#128)', { reason: problem, tables: [...result.tables] });
			throw new ContentStoreUnavailableError(problem);
		}
		healthy = true;
	};
}

/**
 * For a lookup that failed with a real error (not a typed miss): throws
 * {@link ContentStoreUnavailableError} (503) when a fresh probe says the store itself is down,
 * otherwise rethrows the original error (500).
 */
export async function rethrowLookupFailure(error: unknown, assertReady: AssertContentStoreReady): Promise<never> {
	await assertReady({ fresh: true });
	throw error;
}

/**
 * Marker header src/pages/500.astro sets on its content-store-unavailable variant. Astro forces
 * every render of 500.astro to status 500 (runtime/server/render/page.js), so the page cannot
 * answer 503 itself; src/middleware.ts promotes the marked response with
 * {@link promoteContentStoreUnavailable} and strips the marker.
 */
export const CONTENT_STORE_UNAVAILABLE_HEADER = 'x-ft-content-store-unavailable';

/**
 * A 500 page marked with {@link CONTENT_STORE_UNAVAILABLE_HEADER} → the same body as a 503
 * (`Retry-After` and `Cache-Control` kept, marker removed). Any other response is returned as is.
 */
export function promoteContentStoreUnavailable(response: Response): Response {
	if (response.status !== 500 || !response.headers.has(CONTENT_STORE_UNAVAILABLE_HEADER)) return response;
	const headers = new Headers(response.headers);
	headers.delete(CONTENT_STORE_UNAVAILABLE_HEADER);
	if (!headers.has('retry-after')) headers.set('Retry-After', String(CONTENT_STORE_RETRY_AFTER_SECONDS));
	headers.set('Cache-Control', 'no-store');
	return new Response(response.body, { status: 503, statusText: 'Service Unavailable', headers });
}
