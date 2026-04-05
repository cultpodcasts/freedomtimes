import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { getSecret } from 'astro:env/server';

export async function logSecretMeta(key: string) {
  const val = await getSecret(key);
  if (typeof val === 'string') {
    console.log(`[startup] ${key}: length=${val.length}, first='${val[0] ?? ''}'`);
  } else {
    console.log(`[startup] ${key}: not set or not a string`);
  }
}

(async () => {
  await logSecretMeta('AUTH0_DOMAIN');
  await logSecretMeta('AUTH0_CLIENT_ID');
  await logSecretMeta('AUTH0_CLIENT_SECRET');
})();

export const SESSION_COOKIE = 'ft_session';
export const ACCESS_TOKEN_COOKIE = 'ft_access_token';
export const CSRF_COOKIE = 'ft_csrf';
const STATE_COOKIE = 'ft_state';

export async function getRoleClaims(): Promise<string[]> {
  const namespace = (await readOptionalEnv('AUTH0_ROLES_CLAIM_NAMESPACE')).trim().replace(/\/$/, '');
  const claims = ['roles'];
  if (namespace.length > 0) {
    claims.unshift(`${namespace}/roles`);
  }
  return claims;
}

export type AuthConfig = {
  domain: string;
  clientId: string;
  clientSecret: string;
  apiAudience: string;
};


export async function readEnv(key: string): Promise<string> {
  const value = await getSecret(key);
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}


export async function readOptionalEnv(key: string): Promise<string> {
  return (await getSecret(key)) ?? '';
}


export async function getAuthConfig(): Promise<AuthConfig> {
  return {
    domain: await readEnv('AUTH0_DOMAIN'),
    clientId: await readEnv('AUTH0_CLIENT_ID'),
    clientSecret: await readEnv('AUTH0_CLIENT_SECRET'),
    apiAudience: await readEnv('AUTH0_API_AUDIENCE'),
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

export async function getCookieDomainForHost(hostname: string): Promise<string | undefined> {
  const normalized = hostname.trim().toLowerCase();
  const baseDomain = (await readOptionalEnv('COOKIE_BASE_DOMAIN')).trim().toLowerCase().replace(/^\./, '');

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

export async function getCookieDeleteOptionsForHost(hostname: string): Promise<Array<{ path: '/'; domain?: string }>> {
  const cookieDomain = await getCookieDomainForHost(hostname);
  return cookieDomain ? [{ path: '/' }, { path: '/', domain: cookieDomain }] : [{ path: '/' }];
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  config: AuthConfig;
}): Promise<{ idToken: string; accessToken: string }> {
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

  const tokenResponse = (await response.json()) as { id_token?: string; access_token?: string };
  if (!tokenResponse.id_token) {
    throw new Error('Auth0 token exchange did not return id_token');
  }

  if (!tokenResponse.access_token) {
    throw new Error('Auth0 token exchange did not return access_token');
  }

  return {
    idToken: tokenResponse.id_token,
    accessToken: tokenResponse.access_token,
  };
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

export async function hasAdminRole(payload: JWTPayload): Promise<boolean> {
  for (const claim of await getRoleClaims()) {
    const value = payload[claim];
    if (Array.isArray(value) && value.some((r) => String(r).toLowerCase() === 'admin')) {
      return true;
    }
  }
  return false;
}

export async function hasEditorialRole(payload: JWTPayload): Promise<boolean> {
  const allowed = new Set(['admin', 'editor']);
  for (const claim of await getRoleClaims()) {
    const value = payload[claim];
    if (Array.isArray(value) && value.some((r) => allowed.has(String(r).toLowerCase()))) {
      return true;
    }
  }
  return false;
}

export async function getRoleClaimDebug(payload: JWTPayload): Promise<Record<string, unknown>> {
  const roleClaims = await getRoleClaims();
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
