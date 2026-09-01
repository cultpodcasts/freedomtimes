import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isHttpRedirectStatus, shouldTraceFtMwPath } from '../src/lib/ft-mw-trace.ts';

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

	it('enables per-request libsql scope so getDb is not isolate-wide on Workers', () => {
		assert.match(astroConfig, /supportsRequestScope:\s*true/);
		const shim = readFileSync(
			fileURLToPath(new URL('../src/shims/kysely-libsql.ts', import.meta.url)),
			'utf8',
		);
		assert.match(shim, /export function createRequestScopedDb/);
		assert.match(shim, /new Kysely/);
		assert.match(shim, /kyselyLogOption/);
		assert.match(shim, /waitUntil/);
		assert.match(shim, /RequestScopedDbOpts/);
	});

	it('documents the official order so later hang fixes do not call getDb in outer', () => {
		const routingDoc = readFileSync(
			fileURLToPath(new URL('../docs/EMDASH_MIDDLEWARE_AND_ROUTING.md', import.meta.url)),
			'utf8',
		);
		assert.match(routingDoc, /emdash\/middleware\/redirect/);
		assert.match(routingDoc, /supportsRequestScope/);
		assert.match(routingDoc, /createRequestScopedDb/);
		assert.match(routingDoc, /secureAccessWallResponse/);
		assert.match(routingDoc, /Do not add Worker slug maps/);
		assert.match(routingDoc, /Astro\.rewrite/);
		assert.match(routingDoc, /\/login-wall/);
		assert.match(routingDoc, /rewrite is not the 0-byte hang mechanism/);
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
