import type { AstroCookies } from 'astro';
import type { JWTPayload } from 'jose';

import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  SESSION_COOKIE,
  accessTokenNeedsRefresh,
  clearAuthCookies,
  getAuthConfig,
  getCookieDeleteOptionsForHost,
  getDisplayName,
  getRoleClaimDebug,
  tryRefreshAuthCookies,
  verifyIdToken,
} from './auth';

export type AdminSessionBase = {
  displayName: string;
  requestId: string;
};

type AdminPageContext = {
  cookies: AstroCookies;
  url: URL;
  request: Request;
  redirect: (path: string) => Response;
};

type VerifyAdminSessionResult =
  | { ok: true; session: AdminSessionBase; payload: JWTPayload }
  | { ok: false; reason: 'no_session' }
  | { ok: false; reason: 'forbidden'; payload: JWTPayload }
  | { ok: false; reason: 'invalid_token' };

export function jsonAuthError(error: string, status: 401 | 403): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function wipeAuthCookies(cookies: AstroCookies, hostname: string): void {
  clearAuthCookies(cookies, getCookieDeleteOptionsForHost(hostname));
}

export function verifyCsrfToken(cookies: AstroCookies, request: Request): Response | null {
  const cookieToken = cookies.get(CSRF_COOKIE)?.value?.trim() ?? '';
  const headerToken = request.headers.get('x-csrf-token')?.trim() ?? '';

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return jsonAuthError('CSRF validation failed.', 403);
  }

  return null;
}

function adminSessionFromPayload(payload: JWTPayload, requestId: string): AdminSessionBase {
  return {
    displayName: getDisplayName(payload),
    requestId,
  };
}

export async function verifyAdminSession(params: {
  cookies: AstroCookies;
  request: Request;
  url: URL;
  roleCheck: (payload: JWTPayload) => boolean;
  logPrefix: string;
}): Promise<VerifyAdminSessionResult> {
  const requestId = params.request.headers.get('cf-ray') ?? crypto.randomUUID();
  const token = params.cookies.get(SESSION_COOKIE)?.value;

  if (token) {
    try {
      const payload = await verifyIdToken(token, getAuthConfig());
      if (!params.roleCheck(payload)) {
        console.warn(`[${params.logPrefix}] token verified but role check failed`, {
          requestId,
          roleDebug: getRoleClaimDebug(payload),
        });
        return { ok: false, reason: 'forbidden', payload };
      }

      if (accessTokenNeedsRefresh(params.cookies.get(ACCESS_TOKEN_COOKIE)?.value)) {
        const refreshed = await tryRefreshAuthCookies({
          cookies: params.cookies,
          hostname: params.url.hostname,
          requestId,
          logPrefix: params.logPrefix,
          roleCheck: params.roleCheck,
        });
        if (refreshed) {
          return {
            ok: true,
            session: adminSessionFromPayload(refreshed, requestId),
            payload: refreshed,
          };
        }
        console.warn(`[${params.logPrefix}] ID token still valid but access-token refresh failed`, {
          requestId,
        });
      }

      return {
        ok: true,
        session: adminSessionFromPayload(payload, requestId),
        payload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[${params.logPrefix}] token verification failed`, { requestId, message });
      // Fall through to a silent refresh before treating this as logged out.
    }
  } else {
    console.warn(`[${params.logPrefix}] missing session cookie`, { requestId });
  }

  const refreshed = await tryRefreshAuthCookies({
    cookies: params.cookies,
    hostname: params.url.hostname,
    requestId,
    logPrefix: params.logPrefix,
    roleCheck: params.roleCheck,
  });

  if (refreshed) {
    return {
      ok: true,
      session: adminSessionFromPayload(refreshed, requestId),
      payload: refreshed,
    };
  }

  return token ? { ok: false, reason: 'invalid_token' } : { ok: false, reason: 'no_session' };
}

/**
 * Gate `/admin/*` pages. Always requires Auth0 session + role on production and staging.
 */
export async function requireAdminPageSession<T extends AdminSessionBase = AdminSessionBase>(params: {
  context: AdminPageContext;
  roleCheck: (payload: JWTPayload) => boolean;
  loginNextPath: string;
  logPrefix: string;
  buildSession?: (base: AdminSessionBase, payload: JWTPayload) => T;
}): Promise<T | Response> {
  const verified = await verifyAdminSession({
    cookies: params.context.cookies,
    request: params.context.request,
    url: params.context.url,
    roleCheck: params.roleCheck,
    logPrefix: params.logPrefix,
  });

  if (verified.ok) {
    const base = verified.session;
    return params.buildSession ? params.buildSession(base, verified.payload) : (base as T);
  }

  if (verified.reason === 'forbidden') {
    // Keep a valid content-page session (editor / staging-reader). Do not log them out.
    return params.context.redirect('/?denied=1');
  }

  wipeAuthCookies(params.context.cookies, params.context.url.hostname);

  const loginPath = `/auth/login?next=${encodeURIComponent(params.loginNextPath)}`;
  return params.context.redirect(loginPath);
}

/**
 * Gate `/api/admin/*` routes. Always requires Auth0 session + role on production and staging.
 */
export async function authorizeAdminApiRequest<T extends AdminSessionBase = AdminSessionBase>(params: {
  cookies: AstroCookies;
  request: Request;
  url: URL;
  roleCheck: (payload: JWTPayload) => boolean;
  logPrefix: string;
  requireCsrf?: boolean;
  buildSession?: (base: AdminSessionBase, payload: JWTPayload) => T;
}): Promise<T | Response> {
  const verified = await verifyAdminSession({
    cookies: params.cookies,
    request: params.request,
    url: params.url,
    roleCheck: params.roleCheck,
    logPrefix: params.logPrefix,
  });

  if (!verified.ok) {
    if (verified.reason === 'forbidden') {
      return jsonAuthError('Forbidden', 403);
    }

    wipeAuthCookies(params.cookies, params.url.hostname);
    return jsonAuthError('Unauthorized', 401);
  }

  if (
    params.requireCsrf
    && params.request.method !== 'GET'
    && params.request.method !== 'HEAD'
  ) {
    const csrfError = verifyCsrfToken(params.cookies, params.request);
    if (csrfError) {
      return csrfError;
    }
  }

  const base = verified.session;
  return params.buildSession ? params.buildSession(base, verified.payload) : (base as T);
}
