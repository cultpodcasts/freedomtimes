/**
 * Archive PDF availability (#151). An archive entry links its original PDF through EmDash's
 * public media route (`/_emdash/api/media/file/<storageKey>`), which streams the object from the
 * `MEDIA` R2 bucket. When the object is gone (deleted, never promoted to production) the entry
 * still renders, so the archive page checks the object before rendering the link.
 *
 * Kept free of `cloudflare:workers` / `emdash` imports so it can be unit-tested; the page passes
 * a `head` function bound to `env.MEDIA`.
 */

const MEDIA_FILE_PREFIX = '/_emdash/api/media/file/';

/** `available`: object exists. `missing`: R2 answered "no such object". `unknown`: not checked or the check failed (fail open: keep the link). */
export type ArchivePdfStatus = 'available' | 'missing' | 'unknown';

/** Minimal slice of R2Bucket#head: resolves to an object (truthy) or null when the key does not exist. */
export type MediaHead = (key: string) => Promise<unknown>;

/** Log tag for Workers Logs / `wrangler tail` filtering (see CONTENT_PROMOTION_RUNBOOK.md § archive entries). */
export const ARCHIVE_PDF_MISSING_LOG = 'ft.archives.pdf_missing';
export const ARCHIVE_PDF_CHECK_FAILED_LOG = 'ft.archives.pdf_check_failed';

/**
 * Storage key for a same-origin EmDash media file path, or null for anything else.
 * The path segment is percent-decoded once, matching what the media route passes to storage.
 */
export function archivePdfStorageKey(pdfLink: string | null | undefined): string | null {
	if (typeof pdfLink !== 'string' || !pdfLink.startsWith(MEDIA_FILE_PREFIX)) return null;
	const raw = pdfLink.slice(MEDIA_FILE_PREFIX.length).split(/[?#]/, 1)[0] ?? '';
	if (!raw) return null;
	let key: string;
	try {
		key = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (!key || key.startsWith('/') || key.split('/').some((segment) => segment === '..' || segment === '.')) return null;
	return key;
}

/**
 * Response Cache-Control for an archive render: a page that shows the "unavailable" notice must not
 * be page-cached (isStorableResponse skips no-store), so restoring the file fixes the page at once.
 */
export function archivePdfCacheControl(status: ArchivePdfStatus): string | null {
	return status === 'missing' ? 'no-store' : null;
}

export interface ArchivePdfCheck {
	status: ArchivePdfStatus;
	storageKey: string | null;
}

/**
 * Check the archive PDF in storage. Never throws: a failed lookup is `unknown` and the link stays,
 * so an R2 hiccup cannot hide a file that exists. Only a definitive null from `head` is `missing`.
 */
export async function checkArchivePdf(
	pdfLink: string | null | undefined,
	head: MediaHead | null | undefined,
	log: { warn: (...args: unknown[]) => void } = console,
	context: { slug?: string } = {},
): Promise<ArchivePdfCheck> {
	const storageKey = archivePdfStorageKey(pdfLink);
	if (!storageKey || typeof head !== 'function') return { status: 'unknown', storageKey };
	try {
		const object = await head(storageKey);
		if (object) return { status: 'available', storageKey };
		log.warn(ARCHIVE_PDF_MISSING_LOG, JSON.stringify({ slug: context.slug ?? null, storageKey }));
		return { status: 'missing', storageKey };
	} catch (error) {
		log.warn(
			ARCHIVE_PDF_CHECK_FAILED_LOG,
			JSON.stringify({
				slug: context.slug ?? null,
				storageKey,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return { status: 'unknown', storageKey };
	}
}
