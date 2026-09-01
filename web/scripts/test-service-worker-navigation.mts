import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const swSource = readFileSync(fileURLToPath(new URL('../src/service-worker.ts', import.meta.url)), 'utf8');

describe('service worker does not intercept document navigations', () => {
	it('bumps CACHE_NAME and drops "/" from SHELL_ASSETS', () => {
		assert.match(swSource, /CACHE_NAME = '[^']+-shell-v2'/);
		assert.match(swSource, /SHELL_ASSETS = \['\/favicon\.ico', '\/favicon\.svg', '\/manifest\.webmanifest'\]/);
		assert.doesNotMatch(swSource, /SHELL_ASSETS = \['\/'/);
	});

	it('returns without respondWith for navigate / document requests', () => {
		assert.match(swSource, /function isDocumentNavigation/);
		assert.match(swSource, /request\.mode === 'navigate'/);
		assert.match(swSource, /request\.destination === 'document'/);
		assert.match(swSource, /if \(isDocumentNavigation\(request\)\) \{\s*return;/);
		assert.doesNotMatch(
			swSource,
			/if \(request\.mode === 'navigate'\) \{\s*event\.respondWith\(fetch\(request\)/,
		);
	});

	it('times out remaining shell-asset fetches and keeps skipWaiting + clients.claim + push', () => {
		assert.match(swSource, /ASSET_FETCH_TIMEOUT_MS/);
		assert.match(swSource, /fetchWithTimeout/);
		assert.match(swSource, /skipWaiting/);
		assert.match(swSource, /clients\.claim/);
		assert.match(swSource, /addEventListener\('push'/);
		assert.match(swSource, /addEventListener\('notificationclick'/);
	});
});
