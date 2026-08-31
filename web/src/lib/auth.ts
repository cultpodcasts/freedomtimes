import type { AstroCookies } from 'astro';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { env as cfEnv } from 'cloudflare:workers';

export const SESSION_COOKIE = 'ft_session';
export const ACCESS_TOKEN_COOKIE = 'ft_access_token';
export const CSRF_COOKIE = 'ft_csrf';
/** HttpOnly refresh token — used for silent re-authentication once SESSION_COOKIE expires. */
export const REFRESH_TOKEN_COOKIE = 'ft_refresh';
const STATE_COOKIE = 'ft_state';
const NATIVE_APP_COOKIE = 'ft_native_app';
const AUTH_FLOW_COOKIE = 'ft_auth_flow';
/** Short-lived, single-use cookie carrying the post-login redirect target through the Auth0 round trip. */
const RETURN_TO_COOKIE = 'ft_return_to';
const NATIVE_AUTH_CALLBACK_URL = 'news.freedomtimes.app://auth/callback';
/** Matches the state cookie lifetime — the whole Auth0 authorize round trip should complete well within this window. */
export const RETURN_TO_COOKIE_MAX_AGE_SECONDS = 600;

/** Matches `jwt_configuration.lifetime_in_seconds` (`id_token_lifetime_in_seconds`) in `infra/terraform/modules/auth0_app`. */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24; // 24 hours
export const ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = 60 * 30; // 30 minutes
/** Matches `refresh_token_idle_lifetime_seconds` default in `infra/terraform/modules/auth0_app`. */
export const REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 days

function getRoleClaims(): string[] {
  const namespace = readOptionalEnv('AUTH0_ROLES_CLAIM_NAMESPACE').trim().replace(/\/$/, '');
  const claims = ['roles'];

  if (namespace.length > 0) {
    claims.unshift(namespace);
  }

  return claims;
}

export type AuthConfig = {
  domain: string;
  clientId: string;
  clientSecret: string;
  apiAudience: string;
};

export function readEnv(key: string): string {
  const runtimeEnv = cfEnv as Record<string, string | undefined>;
  const value =
    runtimeEnv[key] ??
    (import.meta.env as Record<string, string | undefined>)[key];

  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }

  return value;
}

export function readOptionalEnv(key: string): string {
  const runtimeEnv = cfEnv as Record<string, string | undefined>;
  return runtimeEnv[key] ?? (import.meta.env as Record<string, string | undefined>)[key] ?? '';
}

/** Staging (`SITE_ACCESS_MODE=locked`) — `/` is the login wall; newsroom lives at `/homepage`. */
export function isLockedSiteAccess(): boolean {
  return readOptionalEnv('SITE_ACCESS_MODE').trim().toLowerCase() !== 'public';
}

/**
 * ## Staging access policy (hard rule)
 *
 * **Production** (`SITE_ACCESS_MODE=public`): paths listed here are reachable without
 * Auth0 — anonymous readers can submit tips, subscribe to push, run diagnostics, etc.
 *
 * **Staging** (`SITE_ACCESS_MODE=locked`): **NOTHING** in this list is public.
 * `isPublicReaderPath()` always returns `false` when the site is locked. Every route
 * here must call `authorizeReaderApiRequest` (API) or `requireReaderPageSession` (page)
 * from `editorial-session.ts` so locked staging requires an Auth0 session first.
 *
 * **Never** add staging-only public exceptions. To test reader flows on staging,
 * sign in at `/` (editor or admin role), then open the route.
 *
 * **Not listed here** (separate rules):
 * - `/_emdash/*` — EmDash OAuth/MCP; own auth in middleware (`AUTH_BYPASS_RULES`)
 * - `/auth/*` — login wall must stay reachable on staging
 * - `/` — staging login wall (not a reader bypass)
 * - Editorial content (`/posts/*`, `/homepage`, EmDash pages) — gated by page handlers
 *
 * When adding a new production-public reader route, add it here **and** wire the handler
 * through the central helpers. See `web/docs/STAGING_ACCESS.md`.
 */
export const PUBLIC_READER_PATHS = [
  '/submit-a-tip',
  '/tip-source',
  '/api/story-tips',
  '/api/tip-source.json',
  '/api/version.json',
  '/api/push-subscriptions',
  '/api/notification-diagnostics',
  '/api/push-test-notification',
  '/api/recent-published-posts.json',
  '/manifest.webmanifest',
] as const;

export function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

export function isPublicReaderPath(pathname: string): boolean {
  if (isLockedSiteAccess()) {
    return false;
  }

  const normalized = normalizePathname(pathname);
  return PUBLIC_READER_PATHS.some((path) => normalized === path);
}

/** Editorial home URL: `/homepage` on locked staging, `/` on public production. */
export function getHomePath(): '/' | '/homepage' {
  return isLockedSiteAccess() ? '/homepage' : '/';
}

export function getAuthConfig(): AuthConfig {
  return {
    domain: readEnv('AUTH0_DOMAIN'),
    clientId: readEnv('AUTH0_CLIENT_ID'),
    clientSecret: readEnv('AUTH0_CLIENT_SECRET'),
    apiAudience: readEnv('AUTH0_API_AUDIENCE'),
  };
}

export function makeState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getStateCookieName(): string {
  return STATE_COOKIE;
}

export function getNativeAppCookieName(): string {
  return NATIVE_APP_COOKIE;
}

export function getAuthFlowCookieName(): string {
  return AUTH_FLOW_COOKIE;
}

export function getReturnToCookieName(): string {
  return RETURN_TO_COOKIE;
}

/**
 * Validate a post-login redirect target (`?next=`) before it round-trips through a cookie.
 * Only same-site, path-absolute URLs are allowed — this is the standard open-redirect guard
 * for OAuth `returnTo`/`next` params. Rejects protocol-relative (`//host/...`), absolute
 * (`https://...`), backslash-smuggled, and `/auth/*` paths (would otherwise loop back into
 * the login flow itself).
 */
export function sanitizeReturnToPath(candidate: string | null | undefined): string | null {
  if (!candidate) {
    return null;
  }

  const trimmed = candidate.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return null;
  }

  if (trimmed.startsWith('/auth/')) {
    return null;
  }

  return trimmed;
}

export function isNativeAppContext(value: string | undefined): boolean {
  return value === '1';
}

export function isNativeAuthFlow(value: string | undefined): boolean {
  return value === 'native';
}

export function getAuthRedirectUri(origin: string, useNativeApp: boolean): string {
  return useNativeApp ? NATIVE_AUTH_CALLBACK_URL : `${origin}/auth/callback`;
}

export function getCookieDomainForHost(hostname: string): string | undefined {
  const normalized = hostname.trim().toLowerCase();
  const baseDomain = readOptionalEnv('COOKIE_BASE_DOMAIN').trim().toLowerCase().replace(/^\./, '');

  if (!normalized || normalized === 'localhost') {
    return undefined;
  }

  // Avoid setting Domain for IP/unknown hosts; host-only cookies are safer there.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    return undefined;
  }

  if (baseDomain && (normalized === baseDomain || normalized.endsWith(`.${baseDomain}`))) {
    return `.${baseDomain}`;
  }

  return undefined;
}

export function getCookieDeleteOptionsForHost(hostname: string): Array<{ path: '/'; domain?: string }> {
  const cookieDomain = getCookieDomainForHost(hostname);
  return cookieDomain ? [{ path: '/' }, { path: '/', domain: cookieDomain }] : [{ path: '/' }];
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  config: AuthConfig;
}): Promise<{ idToken: string; accessToken: string; refreshToken?: string }> {
  const { code, redirectUri, config } = params;
  const tokenEndpoint = `https://${config.domain}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth0 token exchange failed: ${response.status} ${text}`);
  }

  const tokenResponse = (await response.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };
  if (!tokenResponse.id_token) {
    throw new Error('Auth0 token exchange did not return id_token');
  }

  if (!tokenResponse.access_token) {
    throw new Error('Auth0 token exchange did not return access_token');
  }

  return {
    idToken: tokenResponse.id_token,
    accessToken: tokenResponse.access_token,
    // Only present when the authorize request included scope=offline_access (see login.ts).
    refreshToken: tokenResponse.refresh_token,
  };
}

/**
 * Silent re-authentication: exchange a stored `ft_refresh` cookie value for a fresh
 * ID/access token pair, without a full Auth0 `/authorize` redirect. Used by
 * `editorial-session.ts` when the ID token has expired. Rotation is enabled on the Auth0
 * application (`enable_refresh_token_rotation`), so Auth0 normally returns a new
 * `refresh_token` on every use — callers must persist it back into `ft_refresh`.
 */
export async function exchangeRefreshTokenForTokens(params: {
  refreshToken: string;
  config: AuthConfig;
}): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
  const { refreshToken, config } = params;
  const tokenEndpoint = `https://${config.domain}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Auth0 refresh_token exchange failed: ${response.status} ${text}`);
  }

  const tokenResponse = (await response.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
  };

  if (!tokenResponse.id_token) {
    throw new Error('Auth0 refresh_token exchange did not return id_token');
  }

  if (!tokenResponse.access_token) {
    throw new Error('Auth0 refresh_token exchange did not return access_token');
  }

  return {
    idToken: tokenResponse.id_token,
    accessToken: tokenResponse.access_token,
    // Fall back to the presented token if Auth0 does not rotate it for some reason.
    refreshToken: tokenResponse.refresh_token ?? refreshToken,
  };
}

/**
 * Set the full set of HttpOnly/JS-readable auth cookies after login or a silent refresh.
 * `csrfToken`/`refreshToken` are optional so callers that only rotate a subset (none, today)
 * can still reuse this helper consistently with `callback.ts`.
 */
export function setAuthCookies(
  cookies: AstroCookies,
  params: {
    idToken: string;
    accessToken: string;
    refreshToken?: string;
    csrfToken?: string;
    cookieDomain?: string;
  },
): void {
  const { idToken, accessToken, refreshToken, csrfToken, cookieDomain } = params;
  const domainOption = cookieDomain ? { domain: cookieDomain } : {};

  cookies.set(SESSION_COOKIE, idToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    ...domainOption,
  });

  cookies.set(ACCESS_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS,
    ...domainOption,
  });

  if (refreshToken) {
    cookies.set(REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
      ...domainOption,
    });
  }

  if (csrfToken) {
    // JS-readable by design for double-submit CSRF protection on mutation requests.
    cookies.set(CSRF_COOKIE, csrfToken, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      ...domainOption,
    });
  }
}

/** Clear every auth cookie (host-only and domain-scoped variants) — login denial, logout, or a failed refresh. */
export function clearAuthCookies(
  cookies: AstroCookies,
  deleteOptionsList: Array<{ path: '/'; domain?: string }>,
): void {
  for (const deleteOptions of deleteOptionsList) {
    cookies.delete(SESSION_COOKIE, deleteOptions);
    cookies.delete(ACCESS_TOKEN_COOKIE, deleteOptions);
    cookies.delete(CSRF_COOKIE, deleteOptions);
    cookies.delete(REFRESH_TOKEN_COOKIE, deleteOptions);
  }
}

export async function verifyIdToken(idToken: string, config: AuthConfig): Promise<JWTPayload> {
  const { alg } = decodeProtectedHeader(idToken);

  const verifyOptions = {
    issuer: `https://${config.domain}/`,
    audience: config.clientId,
  };

  if (alg === 'HS256') {
    const sharedSecret = decodeAuth0ClientSecret(config.clientSecret);
    const { payload } = await jwtVerify(idToken, sharedSecret, {
      ...verifyOptions,
      algorithms: ['HS256'],
    });
    return payload;
  }

  const jwks = createRemoteJWKSet(new URL(`https://${config.domain}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(idToken, jwks, {
    ...verifyOptions,
    algorithms: ['RS256'],
  });

  return payload;
}

function decodeAuth0ClientSecret(secret: string): Uint8Array {
  const normalized = secret.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

export function hasAdminRole(payload: JWTPayload): boolean {
  for (const claim of getRoleClaims()) {
    const value = payload[claim];
    if (Array.isArray(value) && value.some((r) => String(r).toLowerCase() === 'admin')) {
      return true;
    }
  }

  return false;
}

/**
 * Any role that may complete Auth0 login on the site (`admin` or `editor`).
 * Freedom Times `/admin/*` tools require `admin` only; `editor` is for editorial content.
 */
export function hasStaffLoginRole(payload: JWTPayload): boolean {
  return hasEditorialRole(payload);
}

export function getPostLoginPath(_payload: JWTPayload): '/' | '/homepage' {
  return getHomePath();
}

/** Prefer the `?next=` path stored in `ft_return_to` during login; fall back to editorial home. */
export function resolvePostLoginRedirect(
  returnToCookie: string | null | undefined,
  payload: JWTPayload,
): string {
  return sanitizeReturnToPath(returnToCookie) ?? getPostLoginPath(payload);
}

export function hasEditorialRole(payload: JWTPayload): boolean {
  const allowed = new Set(['admin', 'editor']);

  for (const claim of getRoleClaims()) {
    const value = payload[claim];
    if (Array.isArray(value) && value.some((r) => allowed.has(String(r).toLowerCase()))) {
      return true;
    }
  }

  return false;
}

export function getRoleClaimDebug(payload: JWTPayload): Record<string, unknown> {
  const roleClaims = getRoleClaims();
  const roleClaimValues: Record<string, unknown> = {};
  for (const claim of roleClaims) {
    roleClaimValues[claim] = payload[claim] ?? null;
  }

  const availableRoleLikeClaims = Object.keys(payload).filter((k) =>
    k.toLowerCase().endsWith('/roles') || k.toLowerCase() === 'roles',
  );

  return {
    configuredRoleClaims: roleClaims,
    roleClaimValues,
    availableRoleLikeClaims,
    sub: payload.sub ?? null,
  };
}

export function getDisplayName(payload: JWTPayload): string {
  const candidate = payload.name ?? payload.email ?? payload.sub ?? 'Authenticated User';
  return String(candidate);
}
