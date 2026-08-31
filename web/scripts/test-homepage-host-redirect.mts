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
	fileURLToPath(new URL('../src/components/SecureAccessWall.astro', import.meta.url)),
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
		assert.match(homepagePageSource, /shouldRedirectHomepageToRoot/);
		assert.match(
			homepagePageSource,
			/Astro\.redirect\(HOMEPAGE_ROOT_REDIRECT_LOCATION, 301\)/,
		);
		assert.equal(homepagePageSource.includes(STAGING_HOSTNAME), false);
	});

	it('production / renders the reader root directly (no rewrite loop through /homepage)', () => {
		assert.doesNotMatch(indexPageSource, /Astro\.rewrite\('\/homepage'\)/);
		assert.match(indexPageSource, /HomepageView/);
		assert.match(indexPageSource, /SecureAccessWall/);
		assert.doesNotMatch(
			indexPageSource,
			/import HomepageView from/,
			'static HomepageView import leaks newspaper CSS + EmDash fetch onto the locked login wall',
		);
		assert.match(indexPageSource, /import\('\.\.\/components\/HomepageView\.astro'\)/);
	});

	it('SecureAccessWall is an inline-centered blue gateway (styles must not be bundled away)', () => {
		assert.match(secureAccessWallSource, /is:inline/);
		assert.match(secureAccessWallSource, /place-items:\s*center/);
		assert.match(secureAccessWallSource, /background:\s*#0044bb/);
		assert.match(secureAccessWallSource, /min-height:\s*100vh/);
		assert.match(secureAccessWallSource, /<!doctype html>/i);
	});

	it('[slug].astro also redirects a production /homepage fallback', () => {
		assert.match(slugPageSource, /shouldRedirectHomepageToRoot/);
		assert.match(
			slugPageSource,
			/Astro\.redirect\(HOMEPAGE_ROOT_REDIRECT_LOCATION, 301\)/,
		);
	});

	it('HomepageView canonical uses getHomeCanonicalPath (root on production)', () => {
		assert.match(homepageViewSource, /getHomeCanonicalPath/);
		assert.match(homepageViewSource, /canonicalUrl=\{homeCanonicalPath\}/);
		assert.doesNotMatch(homepageViewSource, /canonicalUrl=\{Astro\.url\.pathname\}/);
	});
});
