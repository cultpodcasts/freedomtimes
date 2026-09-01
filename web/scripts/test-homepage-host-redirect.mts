import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	HOMEPAGE_PATH,
	HOMEPAGE_ROOT_REDIRECT_LOCATION,
	PRODUCTION_PUBLIC_HOSTNAMES,
	STAGING_HOSTNAME,
	getHomeCanonicalPath,
	shouldRedirectHomepageToRoot,
} from '../src/lib/homepage-host.ts';

const middlewareSource = readFileSync(
	fileURLToPath(new URL('../src/middleware.ts', import.meta.url)),
	'utf8',
);
const homepagePageSource = readFileSync(
	fileURLToPath(new URL('../src/pages/homepage.astro', import.meta.url)),
	'utf8',
);
const loginRouteSource = readFileSync(
	fileURLToPath(new URL('../src/pages/auth/login.ts', import.meta.url)),
	'utf8',
);
const indexPageSource = readFileSync(
	fileURLToPath(new URL('../src/pages/index.astro', import.meta.url)),
	'utf8',
);
const slugPageSource = readFileSync(
	fileURLToPath(new URL('../src/pages/[slug].astro', import.meta.url)),
	'utf8',
);
const homepageViewSource = readFileSync(
	fileURLToPath(new URL('../src/components/HomepageView.astro', import.meta.url)),
	'utf8',
);
const secureAccessWallSource = readFileSync(
	fileURLToPath(new URL('../src/lib/secure-access-wall.ts', import.meta.url)),
	'utf8',
);
const loginWallPageSource = readFileSync(
	fileURLToPath(new URL('../src/pages/login-wall.astro', import.meta.url)),
	'utf8',
);
const authLibSource = readFileSync(
	fileURLToPath(new URL('../src/lib/auth.ts', import.meta.url)),
	'utf8',
);

const PRODUCTION_APEX = [...PRODUCTION_PUBLIC_HOSTNAMES].find((host) => !host.startsWith('www.'))!;
const PRODUCTION_WWW = [...PRODUCTION_PUBLIC_HOSTNAMES].find((host) => host.startsWith('www.'))!;

describe('shouldRedirectHomepageToRoot', () => {
	it('301s /homepage on the production apex and www to same-host /', () => {
		for (const hostname of [PRODUCTION_APEX, PRODUCTION_WWW]) {
			assert.equal(
				shouldRedirectHomepageToRoot({ pathname: '/homepage', hostname }),
				true,
				hostname,
			);
			assert.equal(
				shouldRedirectHomepageToRoot({ pathname: '/homepage/', hostname }),
				true,
				`${hostname} trailing slash`,
			);
		}

		assert.equal(HOMEPAGE_ROOT_REDIRECT_LOCATION, '/');
		assert.equal(PRODUCTION_PUBLIC_HOSTNAMES.has(PRODUCTION_APEX), true);
		assert.equal(PRODUCTION_PUBLIC_HOSTNAMES.has(PRODUCTION_WWW), true);
		assert.equal(PRODUCTION_PUBLIC_HOSTNAMES.has(STAGING_HOSTNAME), false);
	});

	it('does not redirect staging /homepage (locked editorial newsroom)', () => {
		assert.equal(STAGING_HOSTNAME.startsWith('staging.'), true);
		assert.equal(STAGING_HOSTNAME.endsWith(PRODUCTION_APEX), true);
		assert.equal(
			shouldRedirectHomepageToRoot({
				pathname: '/homepage',
				hostname: STAGING_HOSTNAME,
			}),
			false,
		);
		assert.equal(
			shouldRedirectHomepageToRoot({
				pathname: '/homepage',
				hostname: STAGING_HOSTNAME,
				siteAccessMode: 'public',
			}),
			false,
		);
		assert.equal(
			shouldRedirectHomepageToRoot({
				pathname: '/homepage',
				hostname: STAGING_HOSTNAME,
				siteAccessMode: 'locked',
			}),
			false,
		);
	});

	it('does not redirect production / or other paths', () => {
		assert.equal(
			shouldRedirectHomepageToRoot({ pathname: '/', hostname: PRODUCTION_APEX }),
			false,
		);
		assert.equal(
			shouldRedirectHomepageToRoot({
				pathname: '/posts/weekly-summary',
				hostname: PRODUCTION_APEX,
			}),
			false,
		);
	});

	it('redirects /homepage on a public worker that is not the staging host', () => {
		assert.equal(
			shouldRedirectHomepageToRoot({
				pathname: '/homepage',
				hostname: 'localhost',
				siteAccessMode: 'public',
			}),
			true,
		);
		assert.equal(
			shouldRedirectHomepageToRoot({
				pathname: '/homepage',
				hostname: 'localhost',
				siteAccessMode: 'locked',
			}),
			false,
		);
	});
});

describe('getHomeCanonicalPath', () => {
	it('uses site root on production public hosts, never /homepage', () => {
		assert.equal(
			getHomeCanonicalPath({ hostname: PRODUCTION_APEX }),
			'/',
		);
		assert.equal(
			getHomeCanonicalPath({ hostname: PRODUCTION_WWW, siteAccessMode: 'public' }),
			'/',
		);
		assert.notEqual(getHomeCanonicalPath({ hostname: PRODUCTION_APEX }), HOMEPAGE_PATH);
	});

	it('keeps /homepage as the staging editorial canonical', () => {
		assert.equal(
			getHomeCanonicalPath({ hostname: STAGING_HOSTNAME, siteAccessMode: 'locked' }),
			HOMEPAGE_PATH,
		);
	});
});

describe('homepage host wiring', () => {
	it('middleware 301s /homepage to / via the host helper (no staging origin)', () => {
		assert.match(middlewareSource, /shouldRedirectHomepageToRoot/);
		assert.match(middlewareSource, /HOMEPAGE_ROOT_REDIRECT_LOCATION/);
		assert.match(middlewareSource, /context\.redirect\(HOMEPAGE_ROOT_REDIRECT_LOCATION, 301\)/);
		assert.equal(middlewareSource.includes(STAGING_HOSTNAME), false);
		assert.equal(middlewareSource.includes(`${STAGING_HOSTNAME}${HOMEPAGE_PATH}`), false);
	});

	it('homepage.astro redirects on the production host and does not invent a staging URL', () => {
		assert.match(homepagePageSource, /resolveHomepageGet/);
		assert.match(homepagePageSource, /Astro\.redirect\(homepageAction\.location, homepageAction\.status\)/);
		assert.equal(homepagePageSource.includes(STAGING_HOSTNAME), false);
	});

	it('production / renders the reader root directly (no rewrite loop through /homepage)', () => {
		assert.doesNotMatch(indexPageSource, /Astro\.rewrite\('\/homepage'\)/);
		assert.match(indexPageSource, /import HomepageView from/);
		assert.match(loginWallPageSource, /secureAccessWallResponse/);
		assert.match(indexPageSource, /secureAccessWallResponse/);
		const wallReturn = indexPageSource.indexOf('return secureAccessWallResponse');
		const homepageMarkup = indexPageSource.indexOf('<HomepageView');
		assert.ok(wallReturn >= 0 && homepageMarkup > wallReturn);
	});

	it('locked / returns the wall Response (no rewrite to /login-wall)', () => {
		// A Response is the document boundary so Homepage CSS cannot override
		// Inter / place-items:center. Do not rewrite `/` to `/login-wall` to
		// compose two templates. The old 0-byte custom-domain hang was
		// isolate-wide getDb, not rewrite.
		assert.match(indexPageSource, /resolveRootGet/);
		assert.match(indexPageSource, /rootAction\.kind === 'login-wall'/);
		assert.match(indexPageSource, /return secureAccessWallResponse/);
		assert.doesNotMatch(indexPageSource, /SecureAccessWall/);
		assert.doesNotMatch(indexPageSource, /return Astro\.rewrite\(/);
		assert.match(middlewareSource, /normalizedPath === '\/login-wall'/);
		assert.match(middlewareSource, /resolveLoginWallGet/);
	});

	it('locked /homepage is newsroom-only (anonymous 302 to /, no wall component)', () => {
		assert.doesNotMatch(homepagePageSource, /SecureAccessWall/);
		assert.doesNotMatch(homepagePageSource, /secureAccessWallResponse/);
		assert.match(homepagePageSource, /session instanceof Response/);
		assert.doesNotMatch(homepagePageSource, /return Astro\.rewrite\(/);
		assert.doesNotMatch(slugPageSource, /return Astro\.rewrite\(/);
		assert.doesNotMatch(slugPageSource, /SecureAccessWall/);
	});

	it('locked / sends a live session to /homepage instead of the anonymous wall', () => {
		assert.match(indexPageSource, /getOptionalEditorialSession/);
		assert.match(indexPageSource, /resolveRootGet/);
		assert.match(indexPageSource, /Astro\.redirect\(rootAction\.location, rootAction\.status\)/);
		const wallRender = indexPageSource.indexOf('return secureAccessWallResponse');
		const sessionRedirect = indexPageSource.indexOf('Astro.redirect(rootAction.location, rootAction.status)');
		assert.ok(wallRender >= 0 && sessionRedirect >= 0);
		assert.ok(
			sessionRedirect < wallRender,
			'signed-in redirect must run before the anonymous wall Response',
		);
	});

	it('Secure Access wall keeps the original white centered gateway', () => {
		assert.match(secureAccessWallSource, /place-items:\s*center/);
		assert.match(secureAccessWallSource, /background:\s*#ffffff/);
		assert.match(secureAccessWallSource, /background:\s*#111111/);
		assert.match(secureAccessWallSource, /min-height:\s*100vh/);
		assert.match(secureAccessWallSource, /font-family:\s*'Inter'/);
		assert.doesNotMatch(secureAccessWallSource, /Source Serif/);
		assert.doesNotMatch(secureAccessWallSource, /front-grid/);
		assert.doesNotMatch(
			secureAccessWallSource,
			/html,\s*body\s*\{[^}]*background:\s*#0044bb/,
		);
	});

	it('[slug].astro also redirects a production /homepage fallback', () => {
		assert.match(slugPageSource, /shouldRedirectHomepageToRoot/);
		assert.match(
			slugPageSource,
			/Astro\.redirect\(HOMEPAGE_ROOT_REDIRECT_LOCATION, 301\)/,
		);
	});

	it('locked /homepage does not skip silent refresh when only ft_refresh is present', () => {
		assert.match(homepagePageSource, /resolveHomepageGet/);
		assert.match(homepagePageSource, /refreshCookie:/);
		assert.match(slugPageSource, /resolveHomepageGet/);
		assert.match(slugPageSource, /refreshCookie:/);
		assert.doesNotMatch(homepagePageSource, /if \(!token\) \{\s*return Astro\.rewrite\('\/'\)/);
	});

	it('auth/login skips a new Auth0 authorize when a session is already live', () => {
		assert.match(loginRouteSource, /getOptionalEditorialSession/);
		assert.match(loginRouteSource, /resolveAuthLoginGet/);
		assert.match(loginRouteSource, /already signed in; skipping Auth0 authorize/);
		const existingCheck = loginRouteSource.indexOf('resolveAuthLoginGet');
		const authorize = loginRouteSource.indexOf('scope');
		assert.ok(existingCheck >= 0 && authorize > existingCheck);
	});

	it('getHomePath delegates to editorialHomePath so staging and production stay aligned', () => {
		assert.match(authLibSource, /editorialHomePath\(siteAccessFromMode/);
	});

	it('HomepageView canonical uses getHomeCanonicalPath (root on production)', () => {
		assert.match(homepageViewSource, /getHomeCanonicalPath/);
		assert.match(homepageViewSource, /canonicalUrl=\{homeCanonicalPath\}/);
		assert.doesNotMatch(homepageViewSource, /canonicalUrl=\{Astro\.url\.pathname\}/);
	});
});
