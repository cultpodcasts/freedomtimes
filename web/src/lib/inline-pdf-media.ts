/**
 * EmDash serves non-image media with `Content-Disposition: attachment` so
 * browsers download PDFs. Citation links should open in Chrome's viewer instead.
 * Keep CSP sandbox from EmDash; only flip disposition for real PDFs.
 *
 * Do not inline on path alone: a `.pdf` key with `text/html` / SVG / etc. must
 * stay `attachment` (EmDash’s stored-XSS posture). Allow `application/pdf`, or
 * `application/octet-stream` when the media key ends in `.pdf` (mislabeled upload).
 */

export const EMDASH_MEDIA_FILE_PREFIX = '/_emdash/api/media/file/';

const EMDASH_MEDIA_CSP =
	"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

export function isEmDashMediaFilePath(pathname: string): boolean {
	return pathname.startsWith(EMDASH_MEDIA_FILE_PREFIX);
}

function mediaContentType(contentType: string | null): string {
	return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function pathLooksLikePdf(pathname: string): boolean {
	return pathname.toLowerCase().endsWith('.pdf');
}

/**
 * Whether this media-file response should be shown inline in the browser.
 * Media routes under `/_emdash/api/media/file/` are AUTH_BYPASS (anonymous on
 * locked staging and production) — this helper only chooses disposition.
 */
export function shouldInlinePdfMedia(pathname: string, contentType: string | null): boolean {
	if (!isEmDashMediaFilePath(pathname)) return false;
	const type = mediaContentType(contentType);
	if (type === 'application/pdf') return true;
	if (type === 'application/octet-stream' && pathLooksLikePdf(pathname)) return true;
	return false;
}

/**
 * Returns the same response, or a clone with `Content-Disposition: inline`
 * when the media file is a PDF that EmDash marked as attachment.
 */
export function maybeInlinePdfMediaDisposition(pathname: string, response: Response): Response {
	if (!shouldInlinePdfMedia(pathname, response.headers.get('content-type'))) {
		return response;
	}

	const current = response.headers.get('content-disposition') ?? '';
	if (/^\s*inline\b/i.test(current)) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set('Content-Disposition', 'inline');
	// EmDash always sets these; keep them if present, and pin CSP if a clone dropped it.
	if (!headers.has('Content-Security-Policy')) {
		headers.set('Content-Security-Policy', EMDASH_MEDIA_CSP);
	}
	if (!headers.has('X-Content-Type-Options')) {
		headers.set('X-Content-Type-Options', 'nosniff');
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
