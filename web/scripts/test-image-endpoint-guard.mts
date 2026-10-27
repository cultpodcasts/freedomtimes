import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { matchInternalMediaKey } from 'emdash/media/image-endpoint';

import {
	isImageEndpointPath,
	shouldServeImageOriginal,
} from '../src/lib/image-endpoint-guard.ts';

const base = {
	method: 'GET',
	pathname: '/_image',
	href: '/favicon.png',
	hasImagesBinding: false,
	matchEmDashMediaKey: matchInternalMediaKey,
};

const middlewareSource = readFileSync(
	fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
	'utf8',
);

describe('image-endpoint-guard (no IMAGES binding)', () => {
	it('serves the original for a bundled-asset href when IMAGES is unbound', () => {
		assert.equal(shouldServeImageOriginal(base), true);
		assert.equal(shouldServeImageOriginal({ ...base, method: 'HEAD' }), true);
		assert.equal(shouldServeImageOriginal({ ...base, pathname: '/_image/' }), true);
		assert.equal(
			shouldServeImageOriginal({ ...base, href: 'https://example.com/a.png' }),
			true,
			'remote hrefs go to the passthrough endpoint, which applies image.remotePatterns (403 when not allowed)',
		);
	});

	it('leaves EmDash media hrefs to EmDash (R2 original / IMAGES transform)', () => {
		assert.equal(
			shouldServeImageOriginal({ ...base, href: '/_emdash/api/media/file/01ABC.jpg' }),
			false,
		);
		assert.equal(
			shouldServeImageOriginal({
				...base,
				href: 'https://freedomtimes.news/_emdash/api/media/file/01ABC.jpg?x=1',
			}),
			false,
		);
	});

	it('turns itself off when the IMAGES binding exists', () => {
		assert.equal(shouldServeImageOriginal({ ...base, hasImagesBinding: true }), false);
	});

	it('ignores other paths, methods and a missing href', () => {
		assert.equal(shouldServeImageOriginal({ ...base, pathname: '/_imagex' }), false);
		assert.equal(shouldServeImageOriginal({ ...base, pathname: '/favicon.png' }), false);
		assert.equal(shouldServeImageOriginal({ ...base, method: 'POST' }), false);
		assert.equal(shouldServeImageOriginal({ ...base, href: null }), false);
		assert.equal(shouldServeImageOriginal({ ...base, href: '' }), false);
		assert.equal(isImageEndpointPath('/_image'), true);
		assert.equal(isImageEndpointPath('/_images'), false);
	});

	it('middleware wires the guard to the adapter passthrough endpoint and EmDash matcher', () => {
		assert.match(
			middlewareSource,
			/import \{ GET as serveImagePassthrough \} from '@astrojs\/cloudflare\/image-passthrough-endpoint';/,
		);
		assert.match(
			middlewareSource,
			/import \{ matchInternalMediaKey \} from 'emdash\/media\/image-endpoint';/,
		);
		assert.match(middlewareSource, /hasImagesBinding: Boolean\(\(cfEnv as Record<string, unknown>\)\.IMAGES\)/);
		assert.match(middlewareSource, /matchEmDashMediaKey: matchInternalMediaKey/);
		assert.match(middlewareSource, /return serveImagePassthrough\(context\);/);
	});
});
