import type { APIRoute } from 'astro';

import {
  ACCESS_TOKEN_COOKIE,
  CSRF_COOKIE,
  SESSION_COOKIE,
  getAuthConfig,
  hasAdminRole,
  readOptionalEnv,
  verifyIdToken,
} from '../../lib/auth';

function normalizeEndpointPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildTargetUrl(baseUrl: string, endpointPath: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(endpointPath.slice(1), normalizedBaseUrl).toString();
}

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const sessionToken = cookies.get(SESSION_COOKIE)?.value;
  if (!sessionToken) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const payload = await verifyIdToken(sessionToken, getAuthConfig());
    if (!hasAdminRole(payload)) {
      return new Response('Forbidden', { status: 403 });
    }
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  const apiBaseUrl = readOptionalEnv('API_BASE_URL');
  if (!apiBaseUrl) {
    return new Response('API_BASE_URL is not configured in worker runtime vars.', { status: 500 });
  }

  const endpointPath = normalizeEndpointPath(url.searchParams.get('path') || '/stories');
  const accessToken = cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    return new Response('Access token cookie is missing.', { status: 401 });
  }

  const csrfToken = cookies.get(CSRF_COOKIE)?.value;
  const correlationId = request.headers.get('X-Correlation-ID') || '';

  const upstreamHeaders = new Headers();
  const cookieParts = [`${ACCESS_TOKEN_COOKIE}=${accessToken}`];
  if (csrfToken) {
    cookieParts.push(`${CSRF_COOKIE}=${csrfToken}`);
  }

  upstreamHeaders.set('Cookie', cookieParts.join('; '));
  if (csrfToken) {
    upstreamHeaders.set('X-CSRF-Token', csrfToken);
  }
  if (correlationId) {
    upstreamHeaders.set('X-Correlation-ID', correlationId);
  }

  const upstreamResponse = await fetch(buildTargetUrl(apiBaseUrl, endpointPath), {
    method: 'GET',
    headers: upstreamHeaders,
  });

  const bodyText = await upstreamResponse.text();
  const responseHeaders = new Headers({
    'content-type': upstreamResponse.headers.get('content-type') || 'text/plain; charset=utf-8',
  });

  if (correlationId) {
    responseHeaders.set('X-Correlation-ID', correlationId);
  }

  return new Response(bodyText, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
};