import {
	HOMEPAGE_PATH,
	HOMEPAGE_ROOT_REDIRECT_LOCATION,
	shouldRedirectHomepageToRoot,
} from './homepage-host';

/** Locked staging vs public production (and public smoke-test workers). */
export type SiteAccess = 'locked' | 'public';

export function siteAccessFromMode(mode: string | undefined): SiteAccess {
	return mode?.trim().toLowerCase() === 'public' ? 'public' : 'locked';
}

/** Editorial newsroom URL for this access mode. */
export function editorialHomePath(siteAccess: SiteAccess): '/' | '/homepage' {
	return siteAccess === 'locked' ? HOMEPAGE_PATH : HOMEPAGE_ROOT_REDIRECT_LOCATION;
}

export function hasRefreshableAuthCookies(input: {
	sessionCookie?: string | null;
	refreshCookie?: string | null;
}): boolean {
	return Boolean(input.sessionCookie?.trim() || input.refreshCookie?.trim());
}

export type RootGetAction =
	| { kind: 'login-wall' }
	| { kind: 'redirect'; location: '/' | '/homepage'; status: 302 }
	| { kind: 'render-newsroom' };

/**
 * `GET /` — locked staging is the anonymous wall unless a live/refreshable
 * editorial session exists (those go to `/homepage`). Public production
 * always renders the newsroom here.
 */
export function resolveRootGet(input: {
	siteAccess: SiteAccess;
	hasEditorialSession: boolean;
}): RootGetAction {
	if (input.siteAccess === 'locked') {
		if (input.hasEditorialSession) {
			return { kind: 'redirect', location: editorialHomePath('locked'), status: 302 };
		}
		return { kind: 'login-wall' };
	}
	return { kind: 'render-newsroom' };
}

export type HomepageGetAction =
	| { kind: 'redirect'; location: '/'; status: 301 }
	| { kind: 'login-wall' }
	| { kind: 'require-session' }
	| { kind: 'render-newsroom' };

/**
 * `GET /homepage` — production (and public non-staging workers) 301 to `/`.
 * Locked staging requires Auth0: no cookies → wall; session or refresh →
 * verify (silent refresh allowed).
 */
export function resolveHomepageGet(input: {
	siteAccess: SiteAccess;
	hostname: string;
	sessionCookie?: string | null;
	refreshCookie?: string | null;
}): HomepageGetAction {
	if (
		shouldRedirectHomepageToRoot({
			pathname: HOMEPAGE_PATH,
			hostname: input.hostname,
			siteAccessMode: input.siteAccess,
		})
	) {
		return { kind: 'redirect', location: HOMEPAGE_ROOT_REDIRECT_LOCATION, status: 301 };
	}

	if (input.siteAccess === 'locked') {
		if (!hasRefreshableAuthCookies(input)) {
			return { kind: 'login-wall' };
		}
		return { kind: 'require-session' };
	}

	return { kind: 'render-newsroom' };
}

export type AuthLoginGetAction =
	| { kind: 'redirect'; location: string; status: 302 }
	| { kind: 'authorize' };

/**
 * `GET /auth/login` — do not start a second Auth0 authorize when already
 * signed in (failed callback clears cookies).
 */
export function resolveAuthLoginGet(input: {
	siteAccess: SiteAccess;
	hasEditorialSession: boolean;
	nextPath?: string | null;
}): AuthLoginGetAction {
	if (input.hasEditorialSession) {
		const next = input.nextPath?.trim();
		return {
			kind: 'redirect',
			location: next || editorialHomePath(input.siteAccess),
			status: 302,
		};
	}
	return { kind: 'authorize' };
}

export function resolveLoginWallGet(siteAccess: SiteAccess): 'not-found' | 'render-wall' {
	return siteAccess === 'public' ? 'not-found' : 'render-wall';
}

/** Post-Auth0 landing. `returnTo` must already be sanitized. */
export function resolvePostLoginLanding(input: {
	siteAccess: SiteAccess;
	returnTo?: string | null;
}): string {
	const next = input.returnTo?.trim();
	return next || editorialHomePath(input.siteAccess);
}
