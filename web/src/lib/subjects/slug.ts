/**
 * Subject URLs. A subject is a free-text chip on a post (`subjects`), not an
 * EmDash taxonomy term. The slug is ASCII so it matches the reader page cache
 * and stays free of percent-encoding.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Lowercase, fold accents, turn every other run of characters into one hyphen. */
export function subjectSlug(label: string): string | null {
	const trimmed = label.trim();
	if (!trimmed) return null;
	const folded = trimmed.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
	const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	if (!slug || !SLUG_PATTERN.test(slug)) return null;
	return slug;
}

export function subjectPath(label: string): string | null {
	const slug = subjectSlug(label);
	return slug ? `/subjects/${slug}` : null;
}

export function isSubjectSlug(slug: string): boolean {
	return SLUG_PATTERN.test(slug);
}
