import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	ARCHIVE_PDF_CHECK_FAILED_LOG,
	ARCHIVE_PDF_MISSING_LOG,
	archivePdfStorageKey,
	checkArchivePdf,
} from '../src/lib/content/archive-pdf.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
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
	});

	it('returns null for anything that is not a checkable storage key', () => {
		for (const value of [null, undefined, '', '/_emdash/api/media/file/', 'https://example.com/a.pdf', '/files/a.pdf', '/_emdash/api/media/file/%E0%A4%A', '/_emdash/api/media/file/..%2Fsecret', '/_emdash/api/media/file/%2Fabs']) {
			assert.equal(archivePdfStorageKey(value as string | null | undefined), null, String(value));
		}
	});
});

describe('checkArchivePdf (#151)', () => {
	it('available when R2 head returns an object; heads the decoded key; no log', async () => {
		const { calls, log } = recorder();
		const seen: string[] = [];
		const result = await checkArchivePdf(link, async (k) => { seen.push(k); return { key: k }; }, log, { slug: 'vol-1' });
		assert.deepEqual(result, { status: 'available', storageKey: key });
		assert.deepEqual(seen, [key]);
		assert.equal(calls.length, 0);
	});

	it('missing when R2 head returns null, with a tagged structured log', async () => {
		const { calls, log } = recorder();
		const result = await checkArchivePdf(link, async () => null, log, { slug: 'vol-1' });
		assert.deepEqual(result, { status: 'missing', storageKey: key });
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], ARCHIVE_PDF_MISSING_LOG);
		assert.deepEqual(JSON.parse(String(calls[0][1])), { slug: 'vol-1', storageKey: key });
	});

	it('fails open (unknown, link kept) when the R2 lookup throws, and logs the failure', async () => {
		const { calls, log } = recorder();
		const result = await checkArchivePdf(link, async () => { throw new Error('R2 timeout'); }, log, { slug: 'vol-1' });
		assert.deepEqual(result, { status: 'unknown', storageKey: key });
		assert.equal(calls[0][0], ARCHIVE_PDF_CHECK_FAILED_LOG);
		assert.equal(JSON.parse(String(calls[0][1])).error, 'R2 timeout');
	});

	it('unknown without a binding or a checkable link, and never calls head', async () => {
		const { calls, log } = recorder();
		let called = false;
		const head = async () => { called = true; return null; };
		assert.equal((await checkArchivePdf(link, null, log)).status, 'unknown');
		assert.equal((await checkArchivePdf('https://example.com/a.pdf', head, log)).status, 'unknown');
		assert.equal((await checkArchivePdf(null, head, log)).status, 'unknown');
		assert.equal(called, false);
		assert.equal(calls.length, 0);
	});
});

describe('archive page wiring (#151)', () => {
	it('the archive page checks the PDF via env.MEDIA and passes the status down', () => {
		const page = read('../src/pages/archives/[slug].astro');
		assert.match(page, /checkArchivePdf\(pdfLink, head, console, \{ slug \}\)/);
		assert.match(page, /\.MEDIA/);
		assert.match(page, /pdfStatus=\{pdfStatus\}/);
		const view = read('../src/components/EmDashContentView.astro');
		assert.match(view, /pdfStatus=\{pdfStatus\}/);
	});

	it('EntryMedia replaces the link with an unavailable notice only when missing', () => {
		const media = read('../src/components/content/EntryMedia.astro');
		assert.match(media, /pdfStatus === 'missing' \?/);
		assert.match(media, /data-pdf-status="missing"/);
		assert.match(media, /currently unavailable/);
		assert.match(media, /Open original PDF/);
	});
});
