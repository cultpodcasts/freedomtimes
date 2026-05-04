/** Matches `<details class="translate">` only (same sentinel as Norway Supreme Court flagship PT). */
export const TRANSLATE_DETAILS_OPEN_PATTERN =
	/<details\b[^>]*class\s*=\s*\\?["']translate\\?["'][^>]*>/i;
export const DETAILS_CLOSE_PATTERN = /<\\?\/details>/i;

const SUMMARY_PATTERN = /<summary(?:\s+[^>]*)?>(?:<strong>)?(.+?)(?:<\\?\/strong>)?<\\?\/summary>/i;

export function normalizeTagLine(input: string | null | undefined): string {
	if (!input) {
		return '';
	}
	const normalized = input
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/<p>\s*/gi, '')
		.replace(/\s*<\/p>/gi, '')
		.trim();
	return normalized;
}

export function parseDetailsSummary(input: string | null | undefined): string | null {
	const normalized = normalizeTagLine(input);
	const match = normalized.match(SUMMARY_PATTERN);
	if (match) {
		return match[1].trim();
	}
	if (normalized.toLowerCase().includes('show english translation')) {
		return 'Show English translation';
	}
	return null;
}
