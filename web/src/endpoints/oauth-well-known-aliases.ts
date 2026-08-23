import type { APIRoute } from 'astro';

import {
	EMDASH_OAUTH_AUTHORIZATION_SERVER_LEGACY_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_RFC_PATH,
	EMDASH_OAUTH_AUTHORIZATION_SERVER_ROOT_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_PATH,
	EMDASH_OAUTH_PROTECTED_RESOURCE_RFC_PATH,
} from '../lib/oauth-well-known-paths';

export const prerender = false;

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Cache-Control': 'no-store',
} as const;

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

export function oauthWellKnownAliasOptions(): Response {
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
			'Access-Control-Max-Age': '86400',
		},
	});
}

export const GET: APIRoute = ({ url }) => oauthWellKnownAliasResponse(url);

export const HEAD: APIRoute = ({ url }) => oauthWellKnownAliasResponse(url);

export const OPTIONS: APIRoute = () => oauthWellKnownAliasOptions();
