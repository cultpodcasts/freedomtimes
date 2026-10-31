/**
 * #151: withdrawn archive issues answer **410 Gone**, not 404.
 *
 * "Withdrawn" means the `ec_archives` row still exists (matched by slug or id, like EmDash's
 * loader) and was published at some point (`published_at` is set; EmDash's `unpublish()` keeps
 * it), but is no longer live: unpublished back to draft, or soft-deleted to trash.
 * Everything else stays a plain 404:
 * - no row at all (a typo, or an entry permanently purged from trash: nothing is left to tell),
 * - a draft that was never published (a 410 would reveal that an unreleased issue exists),
 * - a `scheduled` entry (it is coming back, so it is not "gone").
 * Known edge: a draft whose `publishedAt` was filled in by hand before it was ever published
 * (EmDash allows that) also answers 410. The page shows no content either way.
 *
 * Both answers use the same noindex "not found" page (`NotFoundView`). The 410 is also sent with
 * `Cache-Control: no-store`: the page cache only ever stores 200s (`isStorableResponse`), and
 * no-store stops browsers and any proxy holding on to it, so a republish shows straight away.
 *
 * Pure (no Workers or EmDash imports) so `scripts/test-archive-withdrawn.mts` runs under Node.
 * The database read is `archive-withdrawn-db.ts`.
 */

export const ARCHIVE_GONE_STATUS = 410;
export const ARCHIVE_GONE_CACHE_CONTROL = 'no-store';
export const ARCHIVE_WITHDRAWN_CHECK_FAILED_LOG = 'ft.archives.withdrawn_check_failed';

export type ArchiveRowState = {
	status?: unknown;
	deleted_at?: unknown;
	published_at?: unknown;
};

const isSet = (value: unknown) => value !== null && value !== undefined && value !== '';

/** True when one of the rows matching the requested slug/id is a withdrawn (once-public) issue. */
export function isWithdrawnArchive(rows: readonly ArchiveRowState[]): boolean {
	return rows.some((row) => {
		if (!isSet(row.published_at)) return false;
		const status = typeof row.status === 'string' ? row.status : '';
		if (status === 'scheduled') return false;
		return status !== 'published' || isSet(row.deleted_at);
	});
}

export type WithdrawnLookup = (slugOrId: string) => Promise<readonly ArchiveRowState[]>;

/**
 * Fail-open wrapper: a failed lookup answers `false` (plain 404) and logs, so a database hiccup
 * on a page that is already a miss never turns into a 5xx.
 */
export async function checkArchiveWithdrawn(
	slugOrId: string,
	lookup: WithdrawnLookup,
	log: { warn: (...args: unknown[]) => void } = console,
): Promise<boolean> {
	try {
		return isWithdrawnArchive(await lookup(slugOrId));
	} catch (error) {
		log.warn(ARCHIVE_WITHDRAWN_CHECK_FAILED_LOG, {
			slug: slugOrId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
