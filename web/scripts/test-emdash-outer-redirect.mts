import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isHttpRedirectStatus, shouldTraceFtMwPath } from '../src/lib/emdash-exact-redirect.ts';
import { withDeadline } from '../src/lib/with-deadline.ts';

const astroConfig = readFileSync(fileURLToPath(new URL('../astro.config.ts', import.meta.url)), 'utf8');
const outerSource = readFileSync(
	fileURLToPath(new URL('../src/emdash-outer-middleware.ts', import.meta.url)),
	'utf8',
);
const integrationSource = readFileSync(
	fileURLToPath(new URL('../node_modules/emdash/src/astro/integration/index.ts', import.meta.url)),
	'utf8',
);

describe('EmDash middleware.outer logs only (not an app slug map)', () => {
	it('registers middleware.outer before getRuntime in astro.config', () => {
		assert.ok(astroConfig.includes("outer: './src/emdash-outer-middleware.ts'"));
	});

	it('EmDash still registers runtime then redirect; outer is the only reorder', () => {
		assert.match(
			integrationSource,
			/entrypoint:\s*"emdash\/middleware".*entrypoint:\s*"emdash\/middleware\/redirect"/s,
		);
		assert.match(integrationSource, /config\.middleware\?\.outer/);
	});

	it('outer does not call getDb or emdash/middleware/redirect before runtime', () => {
		assert.doesNotMatch(outerSource, /from 'emdash\/middleware\/redirect'/);
		assert.doesNotMatch(outerSource, /emdashRedirect\(/);
		assert.doesNotMatch(outerSource, /await getDb\(/);
		assert.doesNotMatch(outerSource, /getDb\(\)/);
		assert.doesNotMatch(outerSource, /selectFrom\(/);
		assert.doesNotMatch(outerSource, /from 'emdash\/runtime'/);
		assert.match(outerSource, /official-redirect-after-runtime/);
	});

	it('posts/[slug] uses getEmDashEntry and does not invent a lookup timeout or preview gate', () => {
		const postPage = readFileSync(
			fileURLToPath(new URL('../src/pages/posts/[slug].astro', import.meta.url)),
			'utf8',
		);
		assert.match(postPage, /getEmDashEntry\('posts', slug\)/);
		assert.doesNotMatch(postPage, /getEmDashCollection/);
		assert.doesNotMatch(postPage, /Post lookup timed out/);
		assert.doesNotMatch(postPage, /shouldRenderPublicPost/);
	});

	it('logs [ft-mw] enter, defer to official redirect, and next timing', () => {
		assert.match(outerSource, /\[ft-mw\]/);
		for (const event of [
			"'enter'",
			"'redirect-check defer'",
			"'next-start'",
			"'next-end'",
			"'next-hang'",
		]) {
			assert.match(outerSource, new RegExp(event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		}
		assert.match(outerSource, /hasAstroSession/);
		assert.match(outerSource, /hasFtSession/);
		assert.match(outerSource, /cf-ray/);
	});
});

describe('ft-mw path helpers', () => {
	it('traces HTML hang surfaces: posts, login, root, homepage', () => {
		assert.equal(shouldTraceFtMwPath('/posts/weekly-summary-30-august-2026'), true);
		assert.equal(shouldTraceFtMwPath('/auth/login'), true);
		assert.equal(shouldTraceFtMwPath('/'), true);
		assert.equal(shouldTraceFtMwPath('/homepage'), true);
		assert.equal(shouldTraceFtMwPath('/login-wall'), true);
		assert.equal(shouldTraceFtMwPath('/_emdash/admin'), false);
	});

	it('recognizes editorial redirect statuses', () => {
		assert.equal(isHttpRedirectStatus(302), true);
		assert.equal(isHttpRedirectStatus(301), true);
		assert.equal(isHttpRedirectStatus(200), false);
		assert.equal(isHttpRedirectStatus(410), false);
	});
});

describe('withDeadline', () => {
	it('resolves when the work finishes first', async () => {
		assert.equal(await withDeadline(Promise.resolve('ok'), 50, 'fast'), 'ok');
	});

	it('rejects when the deadline wins', async () => {
		await assert.rejects(
			withDeadline(new Promise(() => {}), 10, 'hung-lookup'),
			/hung-lookup timed out after 10ms/,
		);
	});
});
