/** Locked editorial host — `/homepage` stays the newsroom URL. */
export const STAGING_HOSTNAME = 'staging.freedomtimes.news'; // pragma: allowlist secret

/** Public reader hosts — `/homepage` must 301/302 to `/` on the same host. */
export const PRODUCTION_PUBLIC_HOSTNAMES = new Set([
	'freedomtimes.news', // pragma: allowlist secret
	'www.freedomtimes.news', // pragma: allowlist secret
]);

export const HOMEPAGE_PATH = '/homepage';

/** Same-host root. Never a staging (or any other) origin. */
export const HOMEPAGE_ROOT_REDIRECT_LOCATION = '/' as const;

export function isStagingHostname(hostname: string): boolean {
	return hostname.trim().toLowerCase() === STAGING_HOSTNAME;
}

export function isProductionPublicHostname(hostname: string): boolean {
	return PRODUCTION_PUBLIC_HOSTNAMES.has(hostname.trim().toLowerCase());
}

function normalizeHomepagePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

export function isHomepagePath(pathname: string): boolean {
	return normalizeHomepagePathname(pathname) === HOMEPAGE_PATH;
}

/**
 * Direct `/homepage` on the production public site (apex or www), or on a
 * `SITE_ACCESS_MODE=public` worker that is not the staging host, must redirect
 * to `/` on that same host. Staging keeps the editorial `/homepage`.
 */
export function shouldRedirectHomepageToRoot(input: {
	pathname: string;
	hostname: string;
	siteAccessMode?: string;
}): boolean {
	if (!isHomepagePath(input.pathname)) {
		return false;
	}

	const hostname = input.hostname.trim().toLowerCase();
	if (isStagingHostname(hostname)) {
		return false;
	}

	if (isProductionPublicHostname(hostname)) {
		return true;
	}

	return input.siteAccessMode?.trim().toLowerCase() === 'public';
}

/**
 * SEO canonical for the newsroom. Production public hosts always point at `/`
 * (never `/homepage`). Staging keeps `/homepage`.
 */
export function getHomeCanonicalPath(input: {
	hostname: string;
	siteAccessMode?: string;
}): '/' | '/homepage' {
	const hostname = input.hostname.trim().toLowerCase();
	if (isStagingHostname(hostname)) {
		return HOMEPAGE_PATH;
	}
	if (isProductionPublicHostname(hostname)) {
		return HOMEPAGE_ROOT_REDIRECT_LOCATION;
	}
	return input.siteAccessMode?.trim().toLowerCase() === 'public'
		? HOMEPAGE_ROOT_REDIRECT_LOCATION
		: HOMEPAGE_PATH;
}
