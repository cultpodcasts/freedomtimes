/**
 * Well-known OAuth path constants. Imported from astro.config — no handlers.
 *
 * EmDash 0.34 serves:
 *   /.well-known/oauth-authorization-server/_emdash
 *   /.well-known/oauth-protected-resource
 * Do not inject those. Aliases need a route so worker-entry has `routeData`.
 */

export const EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH =
	'/.well-known/oauth-authorization-server/_emdash' as const;

/** URL our middleware used to 302 *to*. EmDash never served it. */
export const EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH =
	'/_emdash/.well-known/oauth-authorization-server' as const;

/**
 * Origin-root well-known (issuer `https://origin`). There is no such AS —
 * issuer is `https://origin/_emdash`. 404, do not 302 (issuer mismatch).
 */
export const EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH =
	'/.well-known/oauth-authorization-server' as const;

export const EMDASH_OAUTH_PROTECTED_RESOURCE_PATH =
	'/.well-known/oauth-protected-resource' as const;

/** RFC 9728 suffix for resource `/_emdash/api/mcp`. EmDash serves the unsuffixed path. */
export const EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH =
	'/.well-known/oauth-protected-resource/_emdash/api/mcp' as const;

export const OAUTH_WELL_KNOWN_ALIAS_ENDPOINT =
	'./src/endpoints/oauth-well-known-aliases.ts' as const;

export const OAUTH_WELL_KNOWN_ALIAS_PATTERNS = [
	EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH,
] as const;

export const EMDASH_OWNED_WELL_KNOWN_PATHS = [
	EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_PATH,
] as const;

/** Pre-existing pages route — must not be stolen by OAuth aliases. */
export const ASSETLINKS_PATH = '/.well-known/assetlinks.json' as const;

export const ASSETLINKS_PAGE_ENDPOINT =
	'src/pages/.well-known/assetlinks.json.ts' as const;

/** Written by astro:routes:resolved; read by test-emdash-oauth-routes.mts. */
export const OAUTH_WELL_KNOWN_ROUTE_MANIFEST = '.astro/oauth-well-known-routes.json' as const;

export type OAuthWellKnownRouteRow = {
	pattern: string;
	entrypoint: string;
};

export function isOAuthWellKnownRoutePattern(pattern: string): boolean {
	return (
		(OAUTH_WELL_KNOWN_ALIAS_PATTERNS as readonly string[]).includes(pattern) ||
		(EMDASH_OWNED_WELL_KNOWN_PATHS as readonly string[]).includes(pattern) ||
		pattern === ASSETLINKS_PATH
	);
}

export function oauthWellKnownRouteRows(
	routes: readonly { pattern: string; entrypoint: string }[],
): OAuthWellKnownRouteRow[] {
	return routes
		.filter((route) => isOAuthWellKnownRoutePattern(route.pattern))
		.map((route) => ({ pattern: route.pattern, entrypoint: route.entrypoint }))
		.sort((a, b) => a.pattern.localeCompare(b.pattern));
}
