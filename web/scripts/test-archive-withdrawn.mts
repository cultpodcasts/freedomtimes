import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	ARCHIVE_GONE_CACHE_CONTROL,
	ARCHIVE_GONE_STATUS,
	ARCHIVE_WITHDRAWN_CHECK_FAILED_LOG,
	checkArchiveWithdrawn,
	isWithdrawnArchive,
} from '../src/lib/content/archive-withdrawn.ts';
import { isStorableResponse } from '../src/lib/page-cache-policy.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const when = '2026-09-06T10:00:00.000Z';

describe('isWithdrawnArchive (#151)', () => {
	it('is true for a once-published entry that was unpublished back to draft', () => {
		assert.equal(isWithdrawnArchive([{ status: 'draft', deleted_at: null, published_at: when }]), true);
	});
	it('is true for a once-published entry in trash (soft delete), even if status is still published', () => {
		assert.equal(isWithdrawnArchive([{ status: 'published', deleted_at: when, published_at: when }]), true);
		assert.equal(isWithdrawnArchive([{ status: 'draft', deleted_at: when, published_at: when }]), true);
	});
	it('is false when nothing matches (typo or permanently purged)', () => {
		assert.equal(isWithdrawnArchive([]), false);
	});
	it('is false for a never-published draft (no leak that it exists)', () => {
		assert.equal(isWithdrawnArchive([{ status: 'draft', deleted_at: null, published_at: null }]), false);
		assert.equal(isWithdrawnArchive([{ status: 'draft', deleted_at: when, published_at: null }]), false);
		assert.equal(isWithdrawnArchive([{ status: 'draft' }]), false);
	});
	it('is false for a scheduled entry (coming back, not gone)', () => {
		assert.equal(isWithdrawnArchive([{ status: 'scheduled', deleted_at: null, published_at: when }]), false);
	});
	it('is false for a live published row (the route would have rendered it)', () => {
		assert.equal(isWithdrawnArchive([{ status: 'published', deleted_at: null, published_at: when }]), false);
	});
});

describe('checkArchiveWithdrawn (#151)', () => {
	it('passes the slug to the lookup and returns its verdict', async () => {
		const seen: string[] = [];
		const got = await checkArchiveWithdrawn('vol-1', async (s) => {
			seen.push(s);
			return [{ status: 'draft', published_at: when }];
		});
		assert.equal(got, true);
		assert.deepEqual(seen, ['vol-1']);
	});
	it('fails open to a plain 404 and logs when the lookup throws', async () => {
		const calls: unknown[][] = [];
		const got = await checkArchiveWithdrawn(
			'vol-1',
			async () => {
				throw new Error('D1 hiccup');
			},
			{ warn: (...args: unknown[]) => calls.push(args) },
		);
		assert.equal(got, false);
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], ARCHIVE_WITHDRAWN_CHECK_FAILED_LOG);
		assert.deepEqual(calls[0][1], { slug: 'vol-1', error: 'D1 hiccup' });
	});
});

describe('410 response caching (#151)', () => {
	const html = { 'content-type': 'text/html; charset=utf-8' };
	it('the page cache never stores a 410, with or without the no-store header', () => {
		assert.equal(ARCHIVE_GONE_STATUS, 410);
		assert.equal(isStorableResponse({ status: 410, headers: new Headers(html) }), false);
		assert.equal(
			isStorableResponse({ status: 410, headers: new Headers({ ...html, 'cache-control': ARCHIVE_GONE_CACHE_CONTROL }) }),
			false,
		);
		// control: the same headers on a 200 are storable without no-store
		assert.equal(isStorableResponse({ status: 200, headers: new Headers(html) }), true);
	});
});

describe('archives/[slug].astro wiring (#151)', () => {
	const page = read('../src/pages/archives/[slug].astro');
	it('checks withdrawn only after a miss on a live store, then sets 410 + no-store, else 404', () => {
		const miss = page.indexOf('await assertContentStoreReady();\n\t\tnotFound = true;');
		const check = page.indexOf('withdrawn = await checkArchiveWithdrawn(slug, lookupArchiveRowState, console);');
		assert.ok(miss > 0 && check > miss, 'withdrawn check runs after the content-store guard');
		assert.ok(page.includes('Astro.response.status = ARCHIVE_GONE_STATUS;'));
		assert.ok(page.includes("Astro.response.headers.set('Cache-Control', ARCHIVE_GONE_CACHE_CONTROL);"));
		assert.ok(page.includes('Astro.response.status = 404;'));
	});
	it('renders the noindex NotFoundView for the 410 too', () => {
		assert.match(page, /notFound && withdrawn \? \(\s*<NotFoundView eyebrow="410"/);
		const view = read('../src/components/NotFoundView.astro');
		assert.match(view, /canonicalUrl=\{null\} noindex/);
	});
	it('the db lookup matches by slug or id and only reads state columns', () => {
		const db = read('../src/lib/content/archive-withdrawn-db.ts');
		assert.match(db, /SELECT status, deleted_at, published_at FROM \$\{sql\.ref\('ec_archives'\)\}/);
		assert.match(db, /WHERE slug = \$\{slugOrId\} OR id = \$\{slugOrId\}/);
		assert.doesNotMatch(db, /\b(UPDATE|INSERT|DELETE)\b/);
	});
});
