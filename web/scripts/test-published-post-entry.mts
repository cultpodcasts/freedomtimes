import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	isExplicitPreviewRequest,
	isPublishedEmDashEntry,
	isUnpublishedDraftSlug,
	shouldRenderPublicPost,
} from '../src/lib/published-post-entry.ts';

const postPageSource = readFileSync(
	fileURLToPath(new URL('../src/pages/posts/[slug].astro', import.meta.url)),
	'utf8',
);

describe('published-only public post SSR', () => {
	it('refuses edit-mode draft preview without ?_preview=', () => {
		assert.equal(
			shouldRenderPublicPost({
				slug: 'weekly-summary-30-august-2026',
				isPreview: true,
				entry: { status: 'draft' },
				allowPreview: false,
			}),
			false,
		);
		assert.equal(
			shouldRenderPublicPost({
				slug: 'weekly-summary-1-september-2026',
				isPreview: false,
				entry: { status: 'published' },
				allowPreview: false,
			}),
			true,
		);
	});

	it('refuses the leftover unpublished draft slug unless preview is explicit', () => {
		assert.equal(isUnpublishedDraftSlug('weekly-summary-30-august-2026-unpublished'), true);
		assert.equal(isUnpublishedDraftSlug('weekly-summary-1-september-2026'), false);
		assert.equal(
			shouldRenderPublicPost({
				slug: 'weekly-summary-30-august-2026-unpublished',
				isPreview: false,
				entry: { status: 'draft', slug: 'weekly-summary-30-august-2026-unpublished' },
				allowPreview: false,
			}),
			false,
		);
		assert.equal(
			shouldRenderPublicPost({
				slug: 'weekly-summary-30-august-2026-unpublished',
				isPreview: true,
				entry: { status: 'draft' },
				allowPreview: true,
			}),
			true,
		);
	});

	it('treats top-level published status as visible', () => {
		assert.equal(isPublishedEmDashEntry({ status: 'published' }), true);
		assert.equal(isPublishedEmDashEntry({ status: 'draft' }), false);
		assert.equal(isPublishedEmDashEntry({ data: { status: 'published' } }), true);
	});

	it('detects EmDash preview tokens only', () => {
		assert.equal(isExplicitPreviewRequest(new URL('https://example.test/posts/x?_preview=tok')), true);
		assert.equal(isExplicitPreviewRequest(new URL('https://example.test/posts/x')), false);
	});
});

describe('posts/[slug].astro does not SSR drafts via session or collection scan', () => {
	it('uses shouldRenderPublicPost and does not import getEmDashCollection', () => {
		assert.match(postPageSource, /shouldRenderPublicPost/);
		assert.match(postPageSource, /isExplicitPreviewRequest/);
		assert.doesNotMatch(postPageSource, /getEmDashCollection/);
		assert.match(postPageSource, /Redirects already ran in middleware\.outer/);
	});
});
