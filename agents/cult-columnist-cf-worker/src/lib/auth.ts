import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../types';

export const ACCESS_TOKEN_COOKIE = 'ft_access_token';
export const UI_STATE_COOKIE = 'ft_ui_state';

export function makeState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  env: Env;
}): Promise<string> {
  const { code, redirectUri, env } = params;
  if (!env.AUTH0_CLIENT_ID || !env.AUTH0_CLIENT_SECRET) {
    throw new Error('AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET are required for token exchange');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: env.AUTH0_CLIENT_ID,
    client_secret: env.AUTH0_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth0 token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Auth0 did not return access_token');
  return data.access_token;
}

export async function verifyAccessTokenForEditor(token: string, env: Env): Promise<JWTPayload> {
  const verified = await jwtVerify(token, getJwks(env.AUTH0_DOMAIN), {
    issuer: `https://${env.AUTH0_DOMAIN}/`,
    audience: env.AUTH0_API_AUDIENCE,
    algorithms: ['RS256'],
  });
  if (!hasEditorialRole(verified.payload, env.AUTH0_ROLES_CLAIM_NAMESPACE)) {
    throw new Error('Forbidden: missing editorial role');
  }
  return verified.payload;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(domain: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  }
  return jwks;
}

function getRoleClaims(namespace: string | undefined): string[] {
  const ns = (namespace ?? '').trim().replace(/\/$/, '');
  if (!ns) {
    return ['roles'];
  }
  return [ns, 'roles'];
}

function hasEditorialRole(payload: JWTPayload, namespace: string | undefined): boolean {
  const allowed = new Set(['admin', 'editor']);

  for (const claim of getRoleClaims(namespace)) {
    const value = payload[claim];
    if (Array.isArray(value) && value.some((v) => allowed.has(String(v).toLowerCase()))) {
      return true;
    }
  }

  return false;
}

export function readCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get('cookie')?.trim() ?? '';
  if (!cookieHeader) {
    return null;
  }

  const prefix = `${name}=`;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  const match = parts.find((p) => p.startsWith(prefix));
  if (!match) {
    return null;
  }

  const rawValue = match.slice(prefix.length);
  if (!rawValue) {
    return null;
  }

  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}

export async function requireEditor(request: Request, env: Env): Promise<JWTPayload> {
  const authHeader = request.headers.get('authorization')?.trim() ?? '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  const cookieToken = readCookieValue(request, 'ft_access_token') ?? '';
  const token = bearerToken || cookieToken;

  if (!token) {
    throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  // For local dev/testing: allow test tokens only when BOTH domain and explicit flag are set.
  // This requires two deliberate configuration choices to activate, preventing accidental
  // enablement in staging or production.
  if (env.AUTH0_DOMAIN === 'test.auth0.com' && env.ALLOW_TEST_TOKENS === 'true') {
    if (token === 'test-editor-token') {
      return {
        sub: 'test-user-editor',
        [env.AUTH0_ROLES_CLAIM_NAMESPACE || 'roles']: ['editor'],
        iat: Math.floor(Date.now() / 1000),
      } as JWTPayload;
    }
    if (token === 'test-viewer-token') {
      const viewerPayload = {
        sub: 'test-user-viewer',
        [env.AUTH0_ROLES_CLAIM_NAMESPACE || 'roles']: ['viewer'],
        iat: Math.floor(Date.now() / 1000),
      } as JWTPayload;
      if (!hasEditorialRole(viewerPayload, env.AUTH0_ROLES_CLAIM_NAMESPACE)) {
        throw new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      return viewerPayload;
    }
    // Invalid test token
    throw new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getJwks(env.AUTH0_DOMAIN), {
      issuer: `https://${env.AUTH0_DOMAIN}/`,
      audience: env.AUTH0_API_AUDIENCE,
      algorithms: ['RS256'],
    });
    payload = verified.payload;
  } catch {
    throw new Response(JSON.stringify({ error: 'Invalid token' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!hasEditorialRole(payload, env.AUTH0_ROLES_CLAIM_NAMESPACE)) {
    throw new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  return payload;
}
