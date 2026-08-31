import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	PRODUCTION_PUBLIC_HOSTNAMES,
	STAGING_HOSTNAME,
} from '../src/lib/homepage-host.ts';
import {
	editorialHomePath,
	hasRefreshableAuthCookies,
	resolveAuthLoginGet,
	resolveHomepageGet,
	resolveLoginWallGet,
	resolvePostLoginLanding,
	resolveRootGet,
	siteAccessFromMode,
	type SiteAccess,
} from '../src/lib/root-route.ts';

const PRODUCTION_APEX = [...PRODUCTION_PUBLIC_HOSTNAMES].find((host) => !host.startsWith('www.'))!;
const PRODUCTION_WWW = [...PRODUCTION_PUBLIC_HOSTNAMES].find((host) => host.startsWith('www.'))!;

describe('siteAccessFromMode / editorialHomePath', () => {
	it('treats anything other than public as locked (staging default)', () => {
		assert.equal(siteAccessFromMode('public'), 'public');
		assert.equal(siteAccessFromMode('PUBLIC'), 'public');
		assert.equal(siteAccessFromMode('locked'), 'locked');
		assert.equal(siteAccessFromMode(''), 'locked');
		assert.equal(siteAccessFromMode(undefined), 'locked');
	});

	it('puts the newsroom on /homepage when locked and / when public', () => {
		assert.equal(editorialHomePath('locked'), '/homepage');
		assert.equal(editorialHomePath('public'), '/');
	});
});

describe('GET / (root)', () => {
	it('staging locked: anonymous visitors get the Secure Access wall', () => {
		assert.deepEqual(resolveRootGet({ siteAccess: 'locked', hasEditorialSession: false }), {
			kind: 'login-wall',
		});
	});

	it('staging locked: a live session 302s to /homepage (do not show the wall)', () => {
		assert.deepEqual(resolveRootGet({ siteAccess: 'locked', hasEditorialSession: true }), {
			kind: 'redirect',
			location: '/homepage',
			status: 302,
		});
	});

	it('production public: / always renders the newsroom, signed in or not', () => {
		for (const hasEditorialSession of [false, true]) {
			assert.deepEqual(
				resolveRootGet({ siteAccess: 'public', hasEditorialSession }),
				{ kind: 'render-newsroom' },
				`hasEditorialSession=${hasEditorialSession}`,
			);
		}
	});

	it('production public: / never becomes the login wall or a /homepage bounce', () => {
		const signedIn = resolveRootGet({ siteAccess: 'public', hasEditorialSession: true });
		const anonymous = resolveRootGet({ siteAccess: 'public', hasEditorialSession: false });
		assert.notEqual(signedIn.kind, 'login-wall');
		assert.notEqual(anonymous.kind, 'login-wall');
		assert.notEqual(signedIn.kind, 'redirect');
		assert.notEqual(anonymous.kind, 'redirect');
	});
});

describe('GET /homepage', () => {
	const lockedStaging = {
		siteAccess: 'locked' as SiteAccess,
		hostname: STAGING_HOSTNAME,
	};
	const publicApex = {
		siteAccess: 'public' as SiteAccess,
		hostname: PRODUCTION_APEX,
	};

	it('staging locked: no auth cookies rewrite to the wall via /', () => {
		assert.deepEqual(resolveHomepageGet({ ...lockedStaging }), { kind: 'login-wall' });
		assert.deepEqual(
			resolveHomepageGet({ ...lockedStaging, sessionCookie: '', refreshCookie: '  ' }),
			{ kind: 'login-wall' },
		);
	});

	it('staging locked: ft_session or ft_refresh alone is enough to attempt the session (stay signed in)', () => {
		assert.deepEqual(
			resolveHomepageGet({ ...lockedStaging, sessionCookie: 'id-token' }),
			{ kind: 'require-session' },
		);
		assert.deepEqual(
			resolveHomepageGet({ ...lockedStaging, refreshCookie: 'refresh-token' }),
			{ kind: 'require-session' },
		);
		assert.deepEqual(
			resolveHomepageGet({
				...lockedStaging,
				sessionCookie: 'id-token',
				refreshCookie: 'refresh-token',
			}),
			{ kind: 'require-session' },
		);
	});

	it('staging host never 301s /homepage to / (even if SITE_ACCESS_MODE is public)', () => {
		assert.deepEqual(
			resolveHomepageGet({
				siteAccess: 'public',
				hostname: STAGING_HOSTNAME,
				sessionCookie: 'id-token',
			}),
			{ kind: 'render-newsroom' },
		);
		assert.notEqual(
			resolveHomepageGet({ siteAccess: 'locked', hostname: STAGING_HOSTNAME }).kind,
			'redirect',
		);
	});

	it('production apex and www: /homepage 301s to same-host / for every cookie state', () => {
		for (const hostname of [PRODUCTION_APEX, PRODUCTION_WWW]) {
			for (const cookies of [
				{},
				{ sessionCookie: 'id-token' },
				{ refreshCookie: 'refresh-token' },
				{ sessionCookie: 'id-token', refreshCookie: 'refresh-token' },
			]) {
				assert.deepEqual(
					resolveHomepageGet({ siteAccess: 'public', hostname, ...cookies }),
					{ kind: 'redirect', location: '/', status: 301 },
					`${hostname} ${JSON.stringify(cookies)}`,
				);
			}
		}
	});

	it('production /homepage redirect is 301 to / — never to staging and never 302 to /homepage', () => {
		const action = resolveHomepageGet(publicApex);
		assert.equal(action.kind, 'redirect');
		if (action.kind === 'redirect') {
			assert.equal(action.location, '/');
			assert.equal(action.status, 301);
		}
	});

	it('public non-staging worker (localhost smoke test) also 301s /homepage to /', () => {
		assert.deepEqual(
			resolveHomepageGet({ siteAccess: 'public', hostname: 'localhost' }),
			{ kind: 'redirect', location: '/', status: 301 },
		);
	});
});

describe('GET /auth/login', () => {
	it('staging: already signed in skips authorize and goes to /homepage', () => {
		assert.deepEqual(
			resolveAuthLoginGet({ siteAccess: 'locked', hasEditorialSession: true }),
			{ kind: 'redirect', location: '/homepage', status: 302 },
		);
	});

	it('production: already signed in skips authorize and goes to /', () => {
		assert.deepEqual(
			resolveAuthLoginGet({ siteAccess: 'public', hasEditorialSession: true }),
			{ kind: 'redirect', location: '/', status: 302 },
		);
	});

	it('honors a sanitized ?next= when already signed in', () => {
		assert.deepEqual(
			resolveAuthLoginGet({
				siteAccess: 'locked',
				hasEditorialSession: true,
				nextPath: '/admin',
			}),
			{ kind: 'redirect', location: '/admin', status: 302 },
		);
	});

	it('anonymous visitors start Auth0 authorize on both access modes', () => {
		assert.deepEqual(resolveAuthLoginGet({ siteAccess: 'locked', hasEditorialSession: false }), {
			kind: 'authorize',
		});
		assert.deepEqual(resolveAuthLoginGet({ siteAccess: 'public', hasEditorialSession: false }), {
			kind: 'authorize',
		});
	});
});

describe('GET /login-wall', () => {
	it('is only a real page on locked staging; public workers 404 it', () => {
		assert.equal(resolveLoginWallGet('locked'), 'render-wall');
		assert.equal(resolveLoginWallGet('public'), 'not-found');
	});
});

describe('post-login landing', () => {
	it('defaults to editorial home for the access mode', () => {
		assert.equal(resolvePostLoginLanding({ siteAccess: 'locked' }), '/homepage');
		assert.equal(resolvePostLoginLanding({ siteAccess: 'public' }), '/');
	});

	it('uses a sanitized returnTo when present', () => {
		assert.equal(
			resolvePostLoginLanding({ siteAccess: 'locked', returnTo: '/admin/tips' }),
			'/admin/tips',
		);
		assert.equal(resolvePostLoginLanding({ siteAccess: 'public', returnTo: '/signed-in' }), '/signed-in');
	});
});

describe('hasRefreshableAuthCookies', () => {
	it('is true when either cookie is present', () => {
		assert.equal(hasRefreshableAuthCookies({}), false);
		assert.equal(hasRefreshableAuthCookies({ sessionCookie: 'x' }), true);
		assert.equal(hasRefreshableAuthCookies({ refreshCookie: 'y' }), true);
		assert.equal(hasRefreshableAuthCookies({ sessionCookie: '', refreshCookie: '' }), false);
	});
});
