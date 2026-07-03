import type { AstroCookies } from 'astro';

import {
	ACCESS_TOKEN_COOKIE,
	CSRF_COOKIE,
	SESSION_COOKIE,
	getAuthConfig,
	getCookieDeleteOptionsForHost,
	getDisplayName,
	getRoleClaimDebug,
	hasEditorialRole,
	isPublicReaderPath,
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
	requestId: string;
};

export async function requireEditorialSession(
	context: EditorialSessionContext,
): Promise<EditorialSession | Response> {
	const requestId = context.request.headers.get('cf-ray') ?? crypto.randomUUID();
	const token = context.cookies.get(SESSION_COOKIE)?.value;

	if (!token) {
		console.warn('[editorial-session] missing session cookie', { requestId });
		return context.redirect('/');
	}

	const deleteOptionsList = getCookieDeleteOptionsForHost(context.url.hostname);

	try {
		const payload = await verifyIdToken(token, getAuthConfig());
		if (!hasEditorialRole(payload)) {
			console.warn('[editorial-session] token verified but role check failed', {
				requestId,
				roleDebug: getRoleClaimDebug(payload),
			});

			for (const deleteOptions of deleteOptionsList) {
				context.cookies.delete(SESSION_COOKIE, deleteOptions);
				context.cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
				context.cookies.delete(CSRF_COOKIE, deleteOptions);
			}

			return context.redirect('/?denied=1');
		}

		return {
			displayName: getDisplayName(payload),
			isEditor: hasEditorialRole(payload),
			requestId,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn('[editorial-session] token verification failed', { requestId, message });

		for (const deleteOptions of deleteOptionsList) {
			context.cookies.delete(SESSION_COOKIE, deleteOptions);
			context.cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
			context.cookies.delete(CSRF_COOKIE, deleteOptions);
		}

		return context.redirect('/');
	}
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

	const token = context.cookies.get(SESSION_COOKIE)?.value;
	if (!token) {
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