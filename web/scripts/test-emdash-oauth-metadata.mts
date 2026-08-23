import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	oauthWellKnownAliasOptions,
	oauthWellKnownAliasResponse,
} from '../src/endpoints/oauth-well-known-aliases.ts';
import {
	EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH,
	OAUTH_WELL_KNOWN_ALIAS_ENDPOINT,
	OAUTH_WELL_KNOWN_ALIAS_PATTERNS,
	oauthWellKnownRouteRows,
} from '../src/lib/oauth-well-known-paths.ts';

const origin = 'https://staging.freedomtimes.news';
const middlewareSource = readFileSync(
	fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
	'utf8',
);
const astroConfigSource = readFileSync(
	fileURLToPath(new URL('../astro.config.ts', import.meta.url)),
	'utf8',
);

function urlFor(path: string): URL {
	return new URL(path, origin);
}

describe('oauthWellKnownAliasResponse', () => {
	it('302s the legacy authorization-server URL to EmDash’s RFC path (absolute Location)', () => {
		const response = oauthWellKnownAliasResponse(
			urlFor(EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH),
		);
		assert.equal(response.status, 302);
		assert.equal(
			response.headers.get('Location'),
			`${origin}${EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH}`,
		);
		assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
	});

	it('treats a trailing slash on the legacy URL the same as the canonical path', () => {
		const response = oauthWellKnownAliasResponse(
			urlFor(`${EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH}/`),
		);
		assert.equal(response.status, 302);
		assert.equal(
			response.headers.get('Location'),
			`${origin}${EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH}`,
		);
	});

	it('404s the origin-root authorization-server well-known (no issuer relocation)', () => {
		const response = oauthWellKnownAliasResponse(urlFor(EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH));
		assert.equal(response.status, 404);
		assert.equal(response.headers.get('Location'), null);
	});

	it('404s the origin-root path with a trailing slash', () => {
		const response = oauthWellKnownAliasResponse(
			urlFor(`${EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH}/`),
		);
		assert.equal(response.status, 404);
		assert.equal(response.headers.get('Location'), null);
	});

	it('302s the RFC 9728 protected-resource suffix toward EmDash’s document', () => {
		const response = oauthWellKnownAliasResponse(urlFor(EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH));
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('Location'), `${origin}${EMDASH_OAUTH_PROTECTED_RESOURCE_PATH}`);
	});

	it('treats a trailing slash on the protected-resource suffix the same as the canonical path', () => {
		const response = oauthWellKnownAliasResponse(
			urlFor(`${EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH}/`),
		);
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('Location'), `${origin}${EMDASH_OAUTH_PROTECTED_RESOURCE_PATH}`);
	});
});

describe('oauthWellKnownAliasOptions', () => {
	it('returns 204 with CORS for browser preflight', () => {
		const response = oauthWellKnownAliasOptions();
		assert.equal(response.status, 204);
		assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
		assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
	});
});

describe('alias inject list', () => {
	it('registers only non-EmDash paths', () => {
		assert.deepEqual(OAUTH_WELL_KNOWN_ALIAS_PATTERNS, [
			EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH,
			EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH,
			EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH,
		]);
		assert.equal(
			(OAUTH_WELL_KNOWN_ALIAS_PATTERNS as readonly string[]).includes(
				EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH,
			),
			false,
		);
		assert.equal(
			(OAUTH_WELL_KNOWN_ALIAS_PATTERNS as readonly string[]).includes(
				EMDASH_OAUTH_PROTECTED_RESOURCE_PATH,
			),
			false,
		);
		assert.match(astroConfigSource, /from '\.\/src\/lib\/oauth-well-known-paths'/);
		assert.doesNotMatch(astroConfigSource, /from '\.\/src\/endpoints\/oauth-well-known-aliases'/);
		assert.equal(OAUTH_WELL_KNOWN_ALIAS_ENDPOINT, './src/endpoints/oauth-well-known-aliases.ts');
	});

	it('filters resolved routes to the five well-known OAuth paths', () => {
		const rows = oauthWellKnownRouteRows([
			{ pattern: '/robots.txt', entrypoint: './src/pages/robots.txt.ts' },
			{
				pattern: EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH,
				entrypoint: 'node_modules/emdash/dist/astro/routes/api/well-known/oauth-authorization-server.mjs',
			},
			{
				pattern: EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH,
				entrypoint: OAUTH_WELL_KNOWN_ALIAS_ENDPOINT,
			},
			{ pattern: '/homepage', entrypoint: './src/pages/homepage.astro' },
		]);
		assert.deepEqual(
			rows.map((row) => row.pattern),
			[EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH, EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH],
		);
	});
});

describe('middleware must not steal EmDash well-known documents', () => {
	it('does not 302 authorization-server or protected-resource discovery', () => {
		assert.doesNotMatch(middlewareSource, /redirect\([^)]*oauth-authorization-server/);
		assert.doesNotMatch(middlewareSource, /redirect\([^)]*oauth-protected-resource/);
	});
});
