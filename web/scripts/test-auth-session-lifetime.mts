import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const authSource = readFileSync(fileURLToPath(new URL('../src/lib/auth.ts', import.meta.url)), 'utf8');
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

describe('auth session lifetime', () => {
	it('keeps the access-token cookie for the same window as ft_session', () => {
		assert.match(
			authSource,
			/export const ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = SESSION_COOKIE_MAX_AGE_SECONDS/,
		);
		assert.doesNotMatch(
			authSource,
			/ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = 60 \* 30/,
		);
	});

	it('shares silent refresh across editorial, admin, and /signed-in', () => {
		assert.match(authSource, /export async function tryRefreshAuthCookies/);
		assert.match(editorialSessionSource, /tryRefreshAuthCookies/);
		assert.match(adminSessionSource, /tryRefreshAuthCookies/);
		assert.match(signedInSource, /tryRefreshAuthCookies/);
	});

	it('lets /admin retry via ft_refresh when ft_session is missing or expired', () => {
		assert.match(adminSessionSource, /missing session cookie/);
		assert.match(adminSessionSource, /Fall through to a silent refresh/);
		assert.match(adminSessionSource, /roleCheck: params\.roleCheck/);
	});
});
