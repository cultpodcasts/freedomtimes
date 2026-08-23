import type { APIRoute } from 'astro';

/**
 * Well-known paths EmDash 0.34 does not register. Each needs an Astro route so
 * worker-entry has `routeData` (otherwise Cloudflare 1101).
 *
 * Do not inject EmDash’s documents:
 *   /.well-known/oauth-authorization-server/_emdash
 *   /.well-known/oauth-protected-resource
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

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Cache-Control': 'no-store',
} as const;

export const prerender = false;

function normalizePath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith('/')) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

function redirectTo(origin: string, pathname: string): Response {
	return new Response(null, {
		status: 302,
		headers: {
			Location: new URL(pathname, origin).href,
			...CORS_HEADERS,
		},
	});
}

function notFound(): Response {
	return new Response(null, { status: 404, headers: CORS_HEADERS });
}

/** Testable without an Astro `APIContext`. */
export function oauthWellKnownAliasResponse(url: URL): Response {
	const path = normalizePath(url.pathname);
	if (path === EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH) {
		return redirectTo(url.origin, EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH);
	}
	if (path === EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH) {
		return redirectTo(url.origin, EMDASH_OAUTH_PROTECTED_RESOURCE_PATH);
	}
	if (path === EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH) {
		return notFound();
	}
	return notFound();
}

export const GET: APIRoute = ({ url }) => oauthWellKnownAliasResponse(url);

export const HEAD: APIRoute = ({ url }) => oauthWellKnownAliasResponse(url);

export const OPTIONS: APIRoute = () =>
	new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Max-Age': '86400',
		},
	});
