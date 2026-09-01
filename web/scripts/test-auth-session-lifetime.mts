import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS,
	ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS,
	SESSION_COOKIE_MAX_AGE_SECONDS,
	accessTokenNeedsRefresh,
} from '../src/lib/auth-session-lifetime.ts';

const authSource = readFileSync(fileURLToPath(new URL('../src/lib/auth.ts', import.meta.url)), 'utf8');
const lifetimeSource = readFileSync(
	fileURLToPath(new URL('../src/lib/auth-session-lifetime.ts', import.meta.url)),
	'utf8',
);
const adminSessionSource = readFileSync(
	fileURLToPath(new URL('../src/lib/admin-session.ts', import.meta.url)),
	'utf8',
);
const editorialSessionSource = readFileSync(
	fileURLToPath(new URL('../src/lib/editorial-session.ts', import.meta.url)),
	'utf8',
);
const signedInSource = readFileSync(
	fileURLToPath(new URL('../src/pages/signed-in.astro', import.meta.url)),
	'utf8',
);

function unsignedJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${header}.${body}.`;
}

describe('auth session lifetime', () => {
	it('keeps the access-token cookie for the same 24h window as ft_session', () => {
		assert.equal(SESSION_COOKIE_MAX_AGE_SECONDS, 60 * 60 * 24);
		assert.equal(ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS, SESSION_COOKIE_MAX_AGE_SECONDS);
		assert.equal(ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS, 60);
		assert.match(
			lifetimeSource,
			/export const ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = SESSION_COOKIE_MAX_AGE_SECONDS/,
		);
		assert.doesNotMatch(
			lifetimeSource,
			/ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = 60 \* 30/,
		);
	});

	it('refreshes when the API JWT is missing, expired, or inside the leeway window', () => {
		const nowMs = Date.UTC(2026, 7, 31, 12, 0, 0);

		assert.equal(accessTokenNeedsRefresh(undefined, nowMs), true);
		assert.equal(accessTokenNeedsRefresh('', nowMs), true);
		assert.equal(accessTokenNeedsRefresh('   ', nowMs), true);
		assert.equal(accessTokenNeedsRefresh('not-a-jwt', nowMs), true);
		assert.equal(accessTokenNeedsRefresh(unsignedJwt({ sub: 'user' }), nowMs), true);

		const expired = unsignedJwt({ exp: nowMs / 1000 - 1 });
		assert.equal(accessTokenNeedsRefresh(expired, nowMs), true);

		const insideLeeway = unsignedJwt({
			exp: nowMs / 1000 + ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS,
		});
		assert.equal(accessTokenNeedsRefresh(insideLeeway, nowMs), true);

		const justOutsideLeeway = unsignedJwt({
			exp: nowMs / 1000 + ACCESS_TOKEN_REFRESH_LEEWAY_SECONDS + 1,
		});
		assert.equal(accessTokenNeedsRefresh(justOutsideLeeway, nowMs), false);

		const farFuture = unsignedJwt({ exp: nowMs / 1000 + 60 * 60 });
		assert.equal(accessTokenNeedsRefresh(farFuture, nowMs), false);
	});

	it('shares silent refresh across editorial, admin, and /signed-in, including access-token exp', () => {
		assert.match(authSource, /export async function tryRefreshAuthCookies/);
		assert.match(authSource, /accessTokenNeedsRefresh/);
		assert.match(editorialSessionSource, /tryRefreshAuthCookies/);
		assert.match(editorialSessionSource, /accessTokenNeedsRefresh/);
		assert.match(adminSessionSource, /tryRefreshAuthCookies/);
		assert.match(adminSessionSource, /accessTokenNeedsRefresh/);
		assert.match(signedInSource, /tryRefreshAuthCookies/);
		assert.match(signedInSource, /accessTokenNeedsRefresh/);
	});

	it('lets /admin retry via ft_refresh when ft_session is missing or expired', () => {
		assert.match(adminSessionSource, /missing session cookie/);
		assert.match(adminSessionSource, /Fall through to a silent refresh/);
		assert.match(adminSessionSource, /roleCheck: params\.roleCheck/);
	});

	it('wipes admin API cookies on failed refresh the same way the page path does', () => {
		assert.match(adminSessionSource, /function wipeAuthCookies/);
		assert.match(
			adminSessionSource,
			/if \(verified\.reason === 'forbidden'\) \{\s*[\s\S]*return params\.context\.redirect\('\/\?denied=1'\);/,
		);
		assert.match(
			adminSessionSource,
			/wipeAuthCookies\(params\.context\.cookies, params\.context\.url\.hostname\);/,
		);
		assert.match(
			adminSessionSource,
			/if \(verified\.reason === 'forbidden'\) \{\s*return jsonAuthError\('Forbidden', 403\);/,
		);
		assert.match(
			adminSessionSource,
			/wipeAuthCookies\(params\.cookies, params\.url\.hostname\);\s*return jsonAuthError\('Unauthorized', 401\);/,
		);
	});

	it('does not log JWTs or decoded payloads from /signed-in', () => {
		assert.doesNotMatch(signedInSource, /sessionToken:\s*token/);
		assert.doesNotMatch(signedInSource, /decodedPayload:/);
		assert.match(signedInSource, /roleDebug: getRoleClaimDebug/);
	});
});
