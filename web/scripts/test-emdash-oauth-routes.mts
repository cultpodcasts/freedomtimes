import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ASSETLINKS_PAGE_ENDPOINT,
	ASSETLINKS_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH,
	OAUTH_WELL_KNOWN_ALIAS_ENDPOINT,
	OAUTH_WELL_KNOWN_ROUTE_MANIFEST,
	type OAuthWellKnownRouteRow,
} from '../src/lib/oauth-well-known-paths.ts';

const manifestPath = fileURLToPath(new URL(`../${OAUTH_WELL_KNOWN_ROUTE_MANIFEST}`, import.meta.url));

function entrypointFile(value: string): string {
	return value.replace(/^\.\//, '');
}

describe('Astro well-known OAuth route manifest', () => {
	it('binds RFC documents to EmDash and aliases to oauth-well-known-aliases', () => {
		assert.equal(
			existsSync(manifestPath),
			true,
			`${OAUTH_WELL_KNOWN_ROUTE_MANIFEST} missing — run astro build (npm run build writes it)`,
		);

		const rows = JSON.parse(readFileSync(manifestPath, 'utf8')) as OAuthWellKnownRouteRow[];
		const byPattern = new Map(rows.map((row) => [row.pattern, row.entrypoint]));

		assert.match(
			byPattern.get(EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH) ?? '',
			/emdash.*oauth-authorization-server/,
		);
		assert.equal(
			entrypointFile(byPattern.get(EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH) ?? ''),
			entrypointFile(OAUTH_WELL_KNOWN_ALIAS_ENDPOINT),
		);
		assert.equal(
			entrypointFile(byPattern.get(EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH) ?? ''),
			entrypointFile(OAUTH_WELL_KNOWN_ALIAS_ENDPOINT),
		);
		assert.match(
			byPattern.get(EMDASH_OAUTH_PROTECTED_RESOURCE_PATH) ?? '',
			/emdash.*oauth-protected-resource/,
		);
		assert.equal(
			entrypointFile(byPattern.get(EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH) ?? ''),
			entrypointFile(OAUTH_WELL_KNOWN_ALIAS_ENDPOINT),
		);
	});

	it('binds /.well-known/assetlinks.json to the pages route, not the OAuth alias', () => {
		assert.equal(
			existsSync(manifestPath),
			true,
			`${OAUTH_WELL_KNOWN_ROUTE_MANIFEST} missing — run astro build (npm run build writes it)`,
		);

		const rows = JSON.parse(readFileSync(manifestPath, 'utf8')) as OAuthWellKnownRouteRow[];
		const entrypoint = rows.find((row) => row.pattern === ASSETLINKS_PATH)?.entrypoint ?? '';
		assert.equal(entrypointFile(entrypoint), ASSETLINKS_PAGE_ENDPOINT);
		assert.doesNotMatch(entrypoint, /oauth-well-known-aliases/);
	});
});
