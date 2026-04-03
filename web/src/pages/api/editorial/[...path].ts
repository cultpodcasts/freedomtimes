import type { APIRoute } from 'astro';
import { ACCESS_TOKEN_COOKIE, CSRF_COOKIE, SESSION_COOKIE, readOptionalEnv } from '../../../lib/auth';

function joinUrl(base: string, path: string, query: string): string {
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}${query}`;
}

function isApimUpstream(): boolean {
  const mode = readOptionalEnv('API_UPSTREAM_MODE').trim().toLowerCase();
  return mode === '' || mode === 'apim';
}

async function proxyRequest(ctx: Parameters<APIRoute>[0]): Promise<Response> {
  const requestId = ctx.request.headers.get('x-correlation-id') ?? crypto.randomUUID();
  const baseUrl = readOptionalEnv('API_BASE_URL');

  if (!baseUrl) {
    return new Response(JSON.stringify({ error: 'API_BASE_URL is not configured' }), {
      status: 500,
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': requestId,
      },
    });
  }

  const accessToken = ctx.cookies.get(ACCESS_TOKEN_COOKIE)?.value;
  const sessionToken = ctx.cookies.get(SESSION_COOKIE)?.value;
  const bearerToken = sessionToken ?? accessToken;

  if (!bearerToken) {
    return new Response(JSON.stringify({ error: 'Missing auth token cookie' }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': requestId,
      },
    });
  }

  const path = ctx.params.path ?? '';
  const targetUrl = joinUrl(baseUrl, path, ctx.url.search);
  const apimUpstream = isApimUpstream();
  const csrfCookie = ctx.cookies.get(CSRF_COOKIE)?.value;
  const csrfHeader = ctx.request.headers.get('x-csrf-token');

  const cookieHeaderParts: string[] = [];
  if (accessToken && !apimUpstream) {
    cookieHeaderParts.push(`${ACCESS_TOKEN_COOKIE}=${accessToken}`);
  }
  if (csrfCookie) {
    cookieHeaderParts.push(`${CSRF_COOKIE}=${csrfCookie}`);
  }

  const outboundHeaders = new Headers();
  outboundHeaders.set('x-correlation-id', requestId);
  outboundHeaders.set('x-ft-proxy', '1');
  outboundHeaders.set('authorization', `Bearer ${bearerToken}`);
  if (cookieHeaderParts.length > 0) {
    outboundHeaders.set('cookie', cookieHeaderParts.join('; '));
  }
  if (csrfHeader) {
    outboundHeaders.set('x-csrf-token', csrfHeader);
  }

  const response = await fetch(targetUrl, {
    method: ctx.request.method,
    headers: outboundHeaders,
    body: ctx.request.method === 'GET' || ctx.request.method === 'HEAD' ? undefined : ctx.request.body,
  });

  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? 'application/json';
  const responseCorrelationId = response.headers.get('x-correlation-id') ?? requestId;

  return new Response(body, {
    status: response.status,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
      'x-correlation-id': responseCorrelationId,
    },
  });
}

export const GET: APIRoute = proxyRequest;
export const POST: APIRoute = proxyRequest;
export const PUT: APIRoute = proxyRequest;
export const PATCH: APIRoute = proxyRequest;
export const DELETE: APIRoute = proxyRequest;
