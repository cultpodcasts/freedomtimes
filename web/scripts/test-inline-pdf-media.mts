import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	EMDASH_MEDIA_FILE_PREFIX,
	isEmDashMediaFilePath,
	maybeInlinePdfMediaDisposition,
	shouldInlinePdfMedia,
} from '../src/lib/inline-pdf-media.ts';

const PDF_PATH = `${EMDASH_MEDIA_FILE_PREFIX}jt-jr-hindle-letter-1970.pdf`;
const PDF_PATH_UPPER = `${EMDASH_MEDIA_FILE_PREFIX}Letter.PDF`;
const JPG_PATH = `${EMDASH_MEDIA_FILE_PREFIX}01M2NCM7J2DMC0NX86QFA3WN0K.jpg`;
const ULID_PDF = `${EMDASH_MEDIA_FILE_PREFIX}01KZ8YQ6K3S20J9MXNF5FQRS2F.pdf`;

const EMDASH_CSP =
	"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

const middlewareSource = readFileSync(
	fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
	'utf8',
);

describe('inline-pdf-media selection', () => {
	it('treats EmDash media-file paths as AUTH_BYPASS media (prefix only)', () => {
		assert.equal(isEmDashMediaFilePath(PDF_PATH), true);
		assert.equal(isEmDashMediaFilePath('/posts/foo.pdf'), false);
		assert.equal(EMDASH_MEDIA_FILE_PREFIX.startsWith('/_emdash/'), true);
	});

	it('inlines application/pdf under the media-file prefix', () => {
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'application/pdf'), true);
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'Application/PDF; charset=binary'), true);
		assert.equal(shouldInlinePdfMedia(ULID_PDF, 'application/pdf'), true);
		assert.equal(shouldInlinePdfMedia(PDF_PATH_UPPER, 'application/pdf'), true);
	});

	it('allows octet-stream only when the media key ends in .pdf', () => {
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'application/octet-stream'), true);
		assert.equal(shouldInlinePdfMedia(JPG_PATH, 'application/octet-stream'), false);
	});

	it('never inlines on path alone when Content-Type is active/document-like', () => {
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'text/html'), false);
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'image/svg+xml'), false);
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'application/javascript'), false);
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'application/json'), false);
		assert.equal(shouldInlinePdfMedia(PDF_PATH, null), false);
		assert.equal(shouldInlinePdfMedia(PDF_PATH, ''), false);
	});

	it('does not treat non-media routes as inline PDFs', () => {
		assert.equal(shouldInlinePdfMedia('/posts/foo', 'application/pdf'), false);
		assert.equal(shouldInlinePdfMedia('/foo.pdf', 'application/pdf'), false);
		assert.equal(shouldInlinePdfMedia(JPG_PATH, 'image/jpeg'), false);
	});
});

describe('maybeInlinePdfMediaDisposition', () => {
	it('rewrites attachment (and filename forms) to inline for PDFs', async () => {
		const body = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
		const upstream = new Response(body, {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': 'attachment; filename="jt-jr-hindle-letter-1970.pdf"',
				'Content-Security-Policy': EMDASH_CSP,
				'X-Content-Type-Options': 'nosniff',
			},
		});
		const next = maybeInlinePdfMediaDisposition(PDF_PATH, upstream);
		assert.notEqual(next, upstream);
		assert.equal(next.headers.get('Content-Disposition'), 'inline');
		assert.equal(next.headers.get('Content-Type'), 'application/pdf');
		assert.equal(next.headers.get('Content-Security-Policy'), EMDASH_CSP);
		assert.equal(next.headers.get('X-Content-Type-Options'), 'nosniff');
		assert.deepEqual(new Uint8Array(await next.arrayBuffer()), body);
	});

	it('rewrites bare attachment for octet-stream .pdf keys', () => {
		const upstream = new Response(null, {
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Disposition': 'attachment',
				'Content-Security-Policy': EMDASH_CSP,
			},
		});
		const next = maybeInlinePdfMediaDisposition(PDF_PATH, upstream);
		assert.equal(next.headers.get('Content-Disposition'), 'inline');
		assert.equal(next.headers.get('Content-Security-Policy'), EMDASH_CSP);
	});

	it('leaves already-inline PDFs and non-PDF media unchanged (same Response)', () => {
		const image = new Response(null, {
			headers: {
				'Content-Type': 'image/jpeg',
				'Content-Disposition': 'inline',
			},
		});
		assert.equal(maybeInlinePdfMediaDisposition(JPG_PATH, image), image);

		const inlinePdf = new Response(null, {
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': 'inline',
			},
		});
		assert.equal(maybeInlinePdfMediaDisposition(PDF_PATH, inlinePdf), inlinePdf);
	});

	it('does not rewrite JSON 404 bodies on a .pdf media path', () => {
		const notFound = new Response(JSON.stringify({ error: 'NOT_FOUND' }), {
			status: 404,
			headers: {
				'Content-Type': 'application/json',
				'Content-Disposition': 'attachment',
			},
		});
		assert.equal(maybeInlinePdfMediaDisposition(PDF_PATH, notFound), notFound);
		assert.equal(notFound.headers.get('Content-Disposition'), 'attachment');
	});

	it('does not rewrite HTML disguised as a .pdf key', () => {
		const html = new Response('<script>alert(1)</script>', {
			status: 200,
			headers: {
				'Content-Type': 'text/html',
				'Content-Disposition': 'attachment',
			},
		});
		assert.equal(maybeInlinePdfMediaDisposition(PDF_PATH, html), html);
	});
});

describe('middleware wires inline PDF on EmDash AUTH_BYPASS', () => {
	it('imports and applies maybeInlinePdfMediaDisposition on bypass and default returns', () => {
		assert.match(
			middlewareSource,
			/import \{ maybeInlinePdfMediaDisposition \} from '\.\/lib\/inline-pdf-media'/,
		);
		assert.match(
			middlewareSource,
			/maybeInjectNativeShellBridge\(\s*path,\s*maybeInlinePdfMediaDisposition\(path, bypassResponse\),\s*\)/,
		);
		assert.match(middlewareSource, /return maybeInlinePdfMediaDisposition\(path, response\);/);
	});

	it('keeps /_emdash/ under AUTH_BYPASS (media files stay anonymous on locked staging)', () => {
		assert.match(middlewareSource, /path: '\/_emdash\/',\s*mode: PathMode\.StartsWith/);
		assert.match(
			middlewareSource,
			/Do not add reader or editorial routes here\. See web\/docs\/STAGING_ACCESS\.md/,
		);
	});
});
