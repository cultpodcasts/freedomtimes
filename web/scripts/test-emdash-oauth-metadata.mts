import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH,
	OAUTH_WELL_KNOWN_ALIAS_ENDPOINT,
	OAUTH_WELL_KNOWN_ALIAS_PATTERNS,
	oauthWellKnownAliasResponse,
} from '../src/endpoints/oauth-well-known-aliases.ts';

const origin = 'https://staging.freedomtimes.news';
const middlewareSource = readFileSync(
	fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
	'utf8',
);
const astroConfigSource = readFileSync(
	fileURLToPath(new URL('../astro.config.ts', import.meta.url)),
	'utf8',
);
const distChunksDir = fileURLToPath(new URL('../dist/server/chunks', import.meta.url));
const hasDist = existsSync(distChunksDir);

function urlFor(path: string): URL {
	return new URL(path, origin);
}

function routeComponentsFromDist(): Map<string, string> {
	const map = new Map<string, string>();
	if (!existsSync(distChunksDir)) {
		return map;
	}
	const re = /"route":\s*"([^"]+)"[\s\S]{0,800}?"component":\s*"([^"]+)"/g;
	for (const file of readdirSync(distChunksDir).filter((name) => name.endsWith('.mjs'))) {
		const text = readFileSync(join(distChunksDir, file), 'utf8');
		for (const match of text.matchAll(re)) {
			map.set(match[1], match[2]);
		}
	}
	return map;
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

	it('404s the origin-root authorization-server well-known (no issuer relocation)', () => {
		const response = oauthWellKnownAliasResponse(urlFor(EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH));
		assert.equal(response.status, 404);
		assert.equal(response.headers.get('Location'), null);
	});

	it('302s the RFC 9728 protected-resource suffix toward EmDash’s document', () => {
		const response = oauthWellKnownAliasResponse(urlFor(EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH));
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('Location'), `${origin}${EMDASH_OAUTH_PROTECTED_RESOURCE_PATH}`);
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
		assert.match(astroConfigSource, /OAUTH_WELL_KNOWN_ALIAS_PATTERNS/);
		assert.equal(OAUTH_WELL_KNOWN_ALIAS_ENDPOINT, './src/endpoints/oauth-well-known-aliases.ts');
	});
});

describe('middleware must not steal EmDash well-known documents', () => {
	it('does not 302 authorization-server or protected-resource discovery', () => {
		assert.doesNotMatch(middlewareSource, /redirect\([^)]*oauth-authorization-server/);
		assert.doesNotMatch(middlewareSource, /redirect\([^)]*oauth-protected-resource/);
	});
});

describe('built Worker route table', () => {
	it('binds RFC documents to EmDash and aliases to the well-known endpoint', (t) => {
		if (!hasDist) {
			t.skip('web/dist/server/chunks missing — run astro build (npm run build always does)');
			return;
		}

		const routes = routeComponentsFromDist();
		const rfcAs = routes.get(EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH);
		const legacyAs = routes.get(EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH);
		const rootAs = routes.get(EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH);
		const prp = routes.get(EMDASH_OAUTH_PROTECTED_RESOURCE_PATH);
		const prpRfc = routes.get(EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH);

		assert.match(rfcAs ?? '', /emdash.*oauth-authorization-server/);
		assert.match(legacyAs ?? '', /oauth-well-known-aliases/);
		assert.match(rootAs ?? '', /oauth-well-known-aliases/);
		assert.match(prp ?? '', /emdash.*oauth-protected-resource/);
		assert.match(prpRfc ?? '', /oauth-well-known-aliases/);
		assert.doesNotMatch(rfcAs ?? '', /oauth-well-known-aliases/);
		assert.doesNotMatch(prp ?? '', /oauth-well-known-aliases/);
	});
});
