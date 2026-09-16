/**
 * EmDash serves non-image media with `Content-Disposition: attachment` so
 * browsers download PDFs. Citation links should open in Chrome's viewer instead.
 * Keep CSP sandbox from EmDash; only flip disposition for PDFs.
 */

export const EMDASH_MEDIA_FILE_PREFIX = '/_emdash/api/media/file/';

export function isEmDashMediaFilePath(pathname: string): boolean {
	return pathname.startsWith(EMDASH_MEDIA_FILE_PREFIX);
}

export function shouldInlinePdfMedia(pathname: string, contentType: string | null): boolean {
	if (!isEmDashMediaFilePath(pathname)) return false;
	const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
	if (type === 'application/pdf') return true;
	return pathname.toLowerCase().endsWith('.pdf');
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
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
