/**
 * Public `/posts/[slug]` must only SSR published entries.
 *
 * EmDash `getEmDashEntry` serves draft revisions when ALS editMode is on
 * (`emdash-edit-mode` + editor session). Locked staging always runs
 * `requireEditorialSession` after a redirect miss; that session must not
 * turn into a draft preview. The leftover
 * `weekly-summary-30-august-2026-unpublished` draft is large enough that
 * rendering it wedges the Worker isolate — after that even EmDash 302s
 * stay pending with no headers.
 *
 * Explicit `?_preview=` tokens still allow draft preview.
 */

export function isExplicitPreviewRequest(url: URL): boolean {
	return url.searchParams.has('_preview');
}

export function isUnpublishedDraftSlug(slug: string | undefined): boolean {
	return Boolean(slug?.endsWith('-unpublished'));
}

function readStatus(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) {
		return value.trim().toLowerCase();
	}
	return null;
}

export function isPublishedEmDashEntry(entry: {
	status?: unknown;
	slug?: unknown;
	data?: unknown;
}): boolean {
	const top = readStatus(entry.status);
	if (top === 'published') {
		return true;
	}
	if (entry.data && typeof entry.data === 'object') {
		return readStatus((entry.data as { status?: unknown }).status) === 'published';
	}
	return false;
}

export function shouldRenderPublicPost(input: {
	slug: string | undefined;
	isPreview: boolean;
	entry: { status?: unknown; slug?: unknown; data?: unknown } | null;
	allowPreview: boolean;
}): boolean {
	if (!input.entry) {
		return false;
	}
	if (input.allowPreview) {
		return true;
	}
	if (input.isPreview) {
		return false;
	}
	if (isUnpublishedDraftSlug(input.slug)) {
		return false;
	}
	return isPublishedEmDashEntry(input.entry);
}
