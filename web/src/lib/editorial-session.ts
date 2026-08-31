import type { AstroCookies } from 'astro';
import type { JWTPayload } from 'jose';

import {
	REFRESH_TOKEN_COOKIE,
	SESSION_COOKIE,
	clearAuthCookies,
	exchangeRefreshTokenForTokens,
	getAuthConfig,
	getCookieDeleteOptionsForHost,
	getCookieDomainForHost,
	getDisplayName,
	getRoleClaimDebug,
	hasAdminRole,
	hasEditorialRole,
	isPublicReaderPath,
	makeState,
	setAuthCookies,
	verifyIdToken,
} from './auth';

type EditorialSessionContext = {
	cookies: AstroCookies;
	url: URL;
	request: Request;
	redirect: (path: string) => Response;
};

type EditorialSession = {
	displayName: string;
	isEditor: boolean;
	isAdmin: boolean;
	requestId: string;
};

function buildSession(payload: JWTPayload, requestId: string): EditorialSession {
	return {
		displayName: getDisplayName(payload),
		isEditor: hasEditorialRole(payload),
		isAdmin: hasAdminRole(payload),
		requestId,
	};
}

/**
 * Silent re-authentication: when the `ft_session` ID token is missing or has expired but a
 * `ft_refresh` cookie is present, exchange it for a fresh token pair (grant_type=refresh_token)
 * instead of forcing a full Auth0 `/authorize` redirect. On success, reissues all auth cookies
 * (Auth0 rotation returns a new refresh_token on every use). See "Refresh tokens (app side)"
 * in web/docs/AUTH.md.
 */
async function tryRefreshSession(
	context: EditorialSessionContext,
	requestId: string,
): Promise<EditorialSession | null> {
	const refreshToken = context.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
	if (!refreshToken) {
		return null;
	}

	try {
		const config = getAuthConfig();
		const refreshed = await exchangeRefreshTokenForTokens({ refreshToken, config });
		const payload = await verifyIdToken(refreshed.idToken, config);

		if (!hasEditorialRole(payload)) {
			console.warn('[editorial-session] refreshed token failed role check', {
				requestId,
				roleDebug: getRoleClaimDebug(payload),
			});
			return null;
		}

		setAuthCookies(context.cookies, {
			idToken: refreshed.idToken,
			accessToken: refreshed.accessToken,
			refreshToken: refreshed.refreshToken,
			csrfToken: makeState(),
			cookieDomain: getCookieDomainForHost(context.url.hostname),
		});

		console.info('[editorial-session] silently refreshed session via refresh_token', { requestId });

		return buildSession(payload, requestId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn('[editorial-session] refresh_token exchange failed', { requestId, message });
		return null;
	}
}

export async function requireEditorialSession(
	context: EditorialSessionContext,
): Promise<EditorialSession | Response> {
	const requestId = context.request.headers.get('cf-ray') ?? crypto.randomUUID();
	const token = context.cookies.get(SESSION_COOKIE)?.value;
	const deleteOptionsList = getCookieDeleteOptionsForHost(context.url.hostname);

	if (token) {
		try {
			const payload = await verifyIdToken(token, getAuthConfig());
			if (!hasEditorialRole(payload)) {
				console.warn('[editorial-session] token verified but role check failed', {
					requestId,
					roleDebug: getRoleClaimDebug(payload),
				});

				clearAuthCookies(context.cookies, deleteOptionsList);
				return context.redirect('/?denied=1');
			}

			return buildSession(payload, requestId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn('[editorial-session] token verification failed', { requestId, message });
			// Fall through to a silent refresh attempt below before giving up.
		}
	} else {
		console.warn('[editorial-session] missing session cookie', { requestId });
	}

	const refreshed = await tryRefreshSession(context, requestId);
	if (refreshed) {
		return refreshed;
	}

	clearAuthCookies(context.cookies, deleteOptionsList);
	return context.redirect('/');
}

/**
 * Soft session probe for public-page nav chrome (Sign in / Sign out / Admin).
 * Returns a session when cookies are valid (or silently refreshable); never redirects
 * and does not clear cookies on failure — protected routes still use requireEditorialSession.
 */
export async function getOptionalEditorialSession(
	context: EditorialSessionContext,
): Promise<EditorialSession | null> {
	const requestId = context.request.headers.get('cf-ray') ?? crypto.randomUUID();
	const token = context.cookies.get(SESSION_COOKIE)?.value;

	if (token) {
		try {
			const payload = await verifyIdToken(token, getAuthConfig());
			if (hasEditorialRole(payload)) {
				return buildSession(payload, requestId);
			}
			return null;
		} catch {
			// Fall through to silent refresh when the ID token is expired/invalid.
		}
	} else if (!context.cookies.get(REFRESH_TOKEN_COOKIE)?.value) {
		return null;
	}

	return tryRefreshSession(context, requestId);
}

export async function authorizeEditorialApiRequest(params: {
	cookies: AstroCookies;
	request: Request;
	url: URL;
}): Promise<EditorialSession | Response> {
	return requireEditorialSession({
		cookies: params.cookies,
		url: params.url,
		request: params.request,
		redirect: () =>
			new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json; charset=utf-8' },
			}),
	});
}

type ReaderPageAccessHandlers = {
	noSession?: () => Response;
	denied?: () => Response;
};

/**
 * Gate reader-facing pages listed in `PUBLIC_READER_PATHS`.
 * Production: anonymous access allowed. Locked staging: requires editorial session.
 */
export async function requireReaderPageSession(
	context: EditorialSessionContext & { pathname: string },
	handlers?: ReaderPageAccessHandlers,
): Promise<EditorialSession | null | Response> {
	if (isPublicReaderPath(context.pathname)) {
		return null;
	}

	// A missing ft_session is not automatically "no session" — a valid ft_refresh cookie can
	// still silently re-authenticate inside requireEditorialSession, so only short-circuit here
	// when neither cookie is present.
	const hasSessionToken = Boolean(context.cookies.get(SESSION_COOKIE)?.value);
	const hasRefreshToken = Boolean(context.cookies.get(REFRESH_TOKEN_COOKIE)?.value);
	if (!hasSessionToken && !hasRefreshToken) {
		return handlers?.noSession?.() ?? context.redirect('/');
	}

	const session = await requireEditorialSession(context);
	if (session instanceof Response) {
		return handlers?.denied?.() ?? session;
	}

	return session;
}

/**
 * Gate reader-facing API routes listed in `PUBLIC_READER_PATHS`.
 * Production: anonymous access allowed. Locked staging: requires editorial session (401).
 */
export async function authorizeReaderApiRequest(params: {
	cookies: AstroCookies;
	request: Request;
	url: URL;
}): Promise<EditorialSession | void | Response> {
	if (isPublicReaderPath(params.url.pathname)) {
		return;
	}

	return authorizeEditorialApiRequest(params);
}
