import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { env as cfEnv } from 'cloudflare:workers';

export const SESSION_COOKIE = 'ft_session';
const STATE_COOKIE = 'ft_state';
const ROLE_CLAIMS = ['https://freedomtimes.news/roles', 'roles'];

export type AuthConfig = {
  domain: string;
  clientId: string;
  clientSecret: string;
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

export function getAuthConfig(): AuthConfig {
  return {
    domain: readEnv('AUTH0_DOMAIN'),
    clientId: readEnv('AUTH0_CLIENT_ID'),
    clientSecret: readEnv('AUTH0_CLIENT_SECRET'),
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

export async function exchangeCodeForIdToken(params: {
  code: string;
  redirectUri: string;
  config: AuthConfig;
}): Promise<string> {
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

  const tokenResponse = (await response.json()) as { id_token?: string };
  if (!tokenResponse.id_token) {
    throw new Error('Auth0 token exchange did not return id_token');
  }

  return tokenResponse.id_token;
}

export async function verifyIdToken(idToken: string, config: AuthConfig): Promise<JWTPayload> {
  const { alg } = decodeProtectedHeader(idToken);

  const verifyOptions = {
    issuer: `https://${config.domain}/`,
    audience: config.clientId,
  };

  if (alg === 'HS256') {
    const sharedSecret = new TextEncoder().encode(config.clientSecret);
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

export function hasAdminRole(payload: JWTPayload): boolean {
  for (const claim of ROLE_CLAIMS) {
    const value = payload[claim];
    if (Array.isArray(value) && value.some((r) => String(r).toLowerCase() === 'admin')) {
      return true;
    }
  }

  return false;
}

export function getDisplayName(payload: JWTPayload): string {
  const candidate = payload.name ?? payload.email ?? payload.sub ?? 'Authenticated User';
  return String(candidate);
}
