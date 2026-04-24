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