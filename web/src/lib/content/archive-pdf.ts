/**
 * Archive PDF availability (#151). An archive entry links its original PDF through EmDash's
 * public media route (`/_emdash/api/media/file/<storageKey>`), which streams the object from the
 * `MEDIA` R2 bucket. When the object is gone (deleted, never promoted to production) the entry
 * still renders, so the archive page checks the object before rendering the link.
 *
 * Kept free of `cloudflare:workers` / `emdash` imports so it can be unit-tested; the page passes
 * a `head` function bound to `env.MEDIA`.
 *
 * #169: size/checksum helpers and optional `source_attribution` reader live here for the same reason.
 */

import { readNonBlankString } from './mediaValue';

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
	/** Byte length from R2 head / media row when known (#169). */
	byteSize: number | null;
}

/**
 * Finite non-negative byte length from an R2 head result or EmDash media row (`size`).
 */
export function readArchivePdfByteSize(source: unknown): number | null {
	if (!source || typeof source !== 'object') return null;
	const size = (source as { size?: unknown }).size;
	if (typeof size === 'number' && Number.isFinite(size) && size >= 0) return size;
	if (typeof size === 'string' && size.trim()) {
		const parsed = Number(size);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return null;
}

/**
 * EmDash media `contentHash` (e.g. `sha1:…`) from a media row or field meta (#169). Never invent.
 */
export function readArchivePdfContentHash(source: unknown): string | null {
	if (!source || typeof source !== 'object') return null;
	const row = source as Record<string, unknown>;
	const meta =
		row.meta && typeof row.meta === 'object' ? (row.meta as Record<string, unknown>) : null;
	const hash =
		(typeof row.contentHash === 'string' && row.contentHash.trim())
		|| (typeof row.content_hash === 'string' && row.content_hash.trim())
		|| (typeof meta?.contentHash === 'string' && meta.contentHash.trim())
		|| (typeof meta?.content_hash === 'string' && meta.content_hash.trim())
		|| '';
	return hash || null;
}

/** Humanized size for the archive PDF link label (e.g. `783 KB`). */
export function formatArchivePdfByteSize(byteSize: number | null | undefined): string | null {
	if (typeof byteSize !== 'number' || !Number.isFinite(byteSize) || byteSize < 0) return null;
	if (byteSize < 1024) return `${Math.round(byteSize)} B`;
	const kib = byteSize / 1024;
	if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;
	const mib = kib / 1024;
	return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`;
}

/** Optional provenance credit from the archives entry (#169). Blank → null. */
export function readArchiveSourceAttribution(data: Record<string, unknown>): string | null {
	return readNonBlankString(data.source_attribution) ?? readNonBlankString(data.sourceAttribution);
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
	if (!storageKey || typeof head !== 'function') return { status: 'unknown', storageKey, byteSize: null };
	try {
		const object = await head(storageKey);
		if (object) {
			return { status: 'available', storageKey, byteSize: readArchivePdfByteSize(object) };
		}
		log.warn(ARCHIVE_PDF_MISSING_LOG, JSON.stringify({ slug: context.slug ?? null, storageKey }));
		return { status: 'missing', storageKey, byteSize: null };
	} catch (error) {
		log.warn(
			ARCHIVE_PDF_CHECK_FAILED_LOG,
			JSON.stringify({
				slug: context.slug ?? null,
				storageKey,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return { status: 'unknown', storageKey, byteSize: null };
	}
}
