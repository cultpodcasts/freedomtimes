import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	ARCHIVE_PDF_CHECK_FAILED_LOG,
	ARCHIVE_PDF_MISSING_LOG,
	archivePdfCacheControl,
	archivePdfStorageKey,
	checkArchivePdf,
	formatArchivePdfByteSize,
	readArchivePdfByteSize,
	readArchivePdfContentHash,
	readArchiveSourceAttribution,
} from '../src/lib/content/archive-pdf.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n'); // CRLF checkouts (Windows autocrlf)
const key = '01M2DW4H4PB5X0AEC83M40GN7R.pdf';
const link = `/_emdash/api/media/file/${key}`;

function recorder() {
	const calls: unknown[][] = [];
	return { calls, log: { warn: (...args: unknown[]) => calls.push(args) } };
}

describe('archivePdfStorageKey (#151)', () => {
	it('extracts the key from a same-origin EmDash media path', () => {
		assert.equal(archivePdfStorageKey(link), key);
		assert.equal(archivePdfStorageKey(`${link}?download=1`), key);
		assert.equal(archivePdfStorageKey('/_emdash/api/media/file/issue%201.pdf'), 'issue 1.pdf');
		assert.equal(archivePdfStorageKey('/_emdash/api/media/file/vol..1.pdf'), 'vol..1.pdf');
		assert.equal(archivePdfStorageKey('/_emdash/api/media/file/archives/vol-1.pdf'), 'archives/vol-1.pdf');
	});

	it('returns null for anything that is not a checkable storage key', () => {
		for (const value of [null, undefined, '', '/_emdash/api/media/file/', 'https://example.com/a.pdf', '/files/a.pdf', '/_emdash/api/media/file/%E0%A4%A', '/_emdash/api/media/file/..%2Fsecret', '/_emdash/api/media/file/a/../b.pdf', '/_emdash/api/media/file/./a.pdf', '/_emdash/api/media/file/%2Fabs']) {
			assert.equal(archivePdfStorageKey(value as string | null | undefined), null, String(value));
		}
	});
});

describe('checkArchivePdf (#151)', () => {
	it('available when R2 head returns an object; heads the decoded key; no log', async () => {
		const { calls, log } = recorder();
		const seen: string[] = [];
		const result = await checkArchivePdf(link, async (k) => { seen.push(k); return { key: k }; }, log, { slug: 'vol-1' });
		assert.deepEqual(result, { status: 'available', storageKey: key, byteSize: null });
		assert.deepEqual(seen, [key]);
		assert.equal(calls.length, 0);
	});

	it('available with byteSize from R2 head size (#169)', async () => {
		const { calls, log } = recorder();
		const result = await checkArchivePdf(link, async () => ({ size: 801538 }), log, { slug: 'vol-1' });
		assert.deepEqual(result, { status: 'available', storageKey: key, byteSize: 801538 });
		assert.equal(calls.length, 0);
	});

	it('missing when R2 head returns null, with a tagged structured log', async () => {
		const { calls, log } = recorder();
		const result = await checkArchivePdf(link, async () => null, log, { slug: 'vol-1' });
		assert.deepEqual(result, { status: 'missing', storageKey: key, byteSize: null });
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], ARCHIVE_PDF_MISSING_LOG);
		assert.deepEqual(JSON.parse(String(calls[0][1])), { slug: 'vol-1', storageKey: key });
	});

	it('fails open (unknown, link kept) when the R2 lookup throws, and logs the failure', async () => {
		const { calls, log } = recorder();
		const result = await checkArchivePdf(link, async () => { throw new Error('R2 timeout'); }, log, { slug: 'vol-1' });
		assert.deepEqual(result, { status: 'unknown', storageKey: key, byteSize: null });
		assert.equal(calls[0][0], ARCHIVE_PDF_CHECK_FAILED_LOG);
		assert.equal(JSON.parse(String(calls[0][1])).error, 'R2 timeout');
	});

	it('unknown without a binding or a checkable link, and never calls head', async () => {
		const { calls, log } = recorder();
		let called = false;
		const head = async () => { called = true; return null; };
		assert.equal((await checkArchivePdf(link, null, log)).status, 'unknown');
		assert.equal((await checkArchivePdf(link, null, log)).byteSize, null);
		assert.equal((await checkArchivePdf('https://example.com/a.pdf', head, log)).status, 'unknown');
		assert.equal((await checkArchivePdf(null, head, log)).status, 'unknown');
		assert.equal(called, false);
		assert.equal(calls.length, 0);
	});
});

describe('archive PDF size/hash readers (#169)', () => {
	it('readArchivePdfByteSize accepts number or numeric string size', () => {
		assert.equal(readArchivePdfByteSize({ size: 801538 }), 801538);
		assert.equal(readArchivePdfByteSize({ size: '1024' }), 1024);
		assert.equal(readArchivePdfByteSize({ size: -1 }), null);
		assert.equal(readArchivePdfByteSize(null), null);
		assert.equal(readArchivePdfByteSize({}), null);
	});

	it('readArchivePdfContentHash reads contentHash from the media row', () => {
		assert.equal(
			readArchivePdfContentHash({ contentHash: 'sha1:3a5d1f79a0dfd4e1f0d0732f7cd501d13f387805' }),
			'sha1:3a5d1f79a0dfd4e1f0d0732f7cd501d13f387805',
		);
		assert.equal(readArchivePdfContentHash({ meta: { content_hash: 'sha1:abc' } }), 'sha1:abc');
		assert.equal(readArchivePdfContentHash({ contentHash: '  ' }), null);
		assert.equal(readArchivePdfContentHash(null), null);
	});

	it('formatArchivePdfByteSize humanizes bytes', () => {
		assert.equal(formatArchivePdfByteSize(500), '500 B');
		assert.equal(formatArchivePdfByteSize(1536), '1.5 KB');
		assert.equal(formatArchivePdfByteSize(801538), '783 KB');
		assert.equal(formatArchivePdfByteSize(5 * 1024 * 1024), '5.0 MB');
		assert.equal(formatArchivePdfByteSize(null), null);
	});
});

describe('readArchiveSourceAttribution (#169)', () => {
	it('passes through source_attribution and ignores blank', () => {
		assert.equal(
			readArchiveSourceAttribution({ source_attribution: 'British Library scan' }),
			'British Library scan',
		);
		assert.equal(readArchiveSourceAttribution({ sourceAttribution: 'Legacy key' }), 'Legacy key');
		assert.equal(readArchiveSourceAttribution({ source_attribution: '  ' }), null);
		assert.equal(readArchiveSourceAttribution({}), null);
	});
});

describe('archivePdfCacheControl (#151)', () => {
	it('no-store only for a missing PDF, so the degraded page is never page-cached', async () => {
		const { isStorableResponse } = await import('../src/lib/page-cache-policy.ts');
		assert.equal(archivePdfCacheControl('missing'), 'no-store');
		assert.equal(archivePdfCacheControl('available'), null);
		assert.equal(archivePdfCacheControl('unknown'), null);
		const probe = (cc: string | null) => isStorableResponse({ status: 200, headers: new Headers({ 'content-type': 'text/html', ...(cc ? { 'cache-control': cc } : {}) }) } as never);
		assert.equal(probe(null), true);
		assert.equal(probe(archivePdfCacheControl('missing')), false);
	});
});

describe('archive page wiring (#151 / #169)', () => {
	it('the archive page checks the PDF via env.MEDIA and passes the status and size down', () => {
		const page = read('../src/pages/archives/[slug].astro');
		assert.match(page, /checkArchivePdf\(pdfLink, head, console, \{ slug \}\)/);
		assert.match(page, /\.MEDIA/);
		assert.match(page, /pdfStatus=\{pdfStatus\}/);
		assert.match(page, /pdfByteSize=\{pdfByteSize\}/);
		assert.match(page, /Astro\.response\.headers\.set\('Cache-Control', cacheControl\)/);
		const view = read('../src/components/EmDashContentView.astro');
		assert.match(view, /pdfStatus=\{pdfStatus\}/);
		assert.match(view, /pdfByteSize=\{pdfByteSize\}/);
		assert.match(view, /sourceAttribution=\{sourceAttribution\}/);
	});

	it('EntryMedia replaces the link with an unavailable notice only when missing', () => {
		const media = read('../src/components/content/EntryMedia.astro');
		assert.match(media, /pdfStatus === 'missing' \?/);
		assert.match(media, /data-pdf-status="missing"/);
		assert.match(media, /currently unavailable/);
		assert.match(media, /Open original PDF/);
		assert.match(media, /formatArchivePdfByteSize/);
		assert.match(media, /source-attribution/);
	});
});
