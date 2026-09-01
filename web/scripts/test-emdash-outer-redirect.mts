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

describe('EmDash middleware.outer wraps EmDash redirect (not an app slug map)', () => {
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

	it('outer delegates to emdash/middleware/redirect and does not query _emdash_redirects itself', () => {
		assert.match(outerSource, /from 'emdash\/middleware\/redirect'/);
		assert.match(outerSource, /emdashRedirect\(/);
		assert.doesNotMatch(outerSource, /selectFrom\(/);
		assert.doesNotMatch(outerSource, /from 'emdash\/runtime'/);
	});

	it('logs [ft-mw] enter, redirect-check, next, and redirect-return', () => {
		assert.match(outerSource, /\[ft-mw\]/);
		for (const event of [
			"'enter'",
			"'redirect-check start'",
			"'redirect-check hit'",
			"'redirect-check miss'",
			"'redirect-return'",
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
