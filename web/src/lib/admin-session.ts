import type { AstroCookies } from 'astro';
import type { JWTPayload } from 'jose';

import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  SESSION_COOKIE,
  getAuthConfig,
  getCookieDeleteOptionsForHost,
  getDisplayName,
  getRoleClaimDebug,
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

export function clearAuthCookies(cookies: AstroCookies, hostname: string): void {
  const deleteOptionsList = getCookieDeleteOptionsForHost(hostname);
  for (const deleteOptions of deleteOptionsList) {
    cookies.delete(SESSION_COOKIE, deleteOptions);
    cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
    cookies.delete(CSRF_COOKIE, deleteOptions);
  }
}

export function verifyCsrfToken(cookies: AstroCookies, request: Request): Response | null {
  const cookieToken = cookies.get(CSRF_COOKIE)?.value?.trim() ?? '';
  const headerToken = request.headers.get('x-csrf-token')?.trim() ?? '';

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return jsonAuthError('CSRF validation failed.', 403);
  }

  return null;
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

  if (!token) {
    console.warn(`[${params.logPrefix}] missing session cookie`, { requestId });
    return { ok: false, reason: 'no_session' };
  }

  try {
    const payload = await verifyIdToken(token, getAuthConfig());
    if (!params.roleCheck(payload)) {
      console.warn(`[${params.logPrefix}] token verified but role check failed`, {
        requestId,
        roleDebug: getRoleClaimDebug(payload),
      });
      return { ok: false, reason: 'forbidden', payload };
    }

    return {
      ok: true,
      session: {
        displayName: getDisplayName(payload),
        requestId,
      },
      payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${params.logPrefix}] token verification failed`, { requestId, message });
    return { ok: false, reason: 'invalid_token' };
  }
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
    clearAuthCookies(params.context.cookies, params.context.url.hostname);
    return params.context.redirect('/?denied=1');
  }

  const loginPath = `/auth/login?next=${encodeURIComponent(params.loginNextPath)}`;
  if (verified.reason === 'invalid_token') {
    clearAuthCookies(params.context.cookies, params.context.url.hostname);
  }

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
