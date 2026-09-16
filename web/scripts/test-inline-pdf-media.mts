import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	maybeInlinePdfMediaDisposition,
	shouldInlinePdfMedia,
} from '../src/lib/inline-pdf-media.ts';

const PDF_PATH = '/_emdash/api/media/file/jt-jr-hindle-letter-1970.pdf';
const JPG_PATH = '/_emdash/api/media/file/01M2NCM7J2DMC0NX86QFA3WN0K.jpg';

describe('inline-pdf-media', () => {
	it('selects PDFs by content-type or .pdf path under media file prefix', () => {
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'application/pdf'), true);
		assert.equal(shouldInlinePdfMedia(PDF_PATH, 'application/octet-stream'), true);
		assert.equal(shouldInlinePdfMedia(JPG_PATH, 'image/jpeg'), false);
		assert.equal(shouldInlinePdfMedia('/posts/foo', 'application/pdf'), false);
	});

	it('rewrites Content-Disposition attachment to inline for PDFs', () => {
		const upstream = new Response(new Uint8Array([1, 2, 3]), {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': 'attachment',
			},
		});
		const next = maybeInlinePdfMediaDisposition(PDF_PATH, upstream);
		assert.equal(next.headers.get('Content-Disposition'), 'inline');
		assert.equal(next.headers.get('Content-Type'), 'application/pdf');
	});

	it('leaves non-PDF media and already-inline PDFs unchanged', () => {
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
});
