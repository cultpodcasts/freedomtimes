import { defineMiddleware } from 'astro:middleware';
import { env as cfEnv } from 'cloudflare:workers';

import { recordPageView } from './lib/page-view-analytics';

enum PathMode {
  Exact = 'exact',
  StartsWith = 'startsWith',
}

type PathRule = {
  path: string;
  mode: PathMode;
};

const AUTH_BYPASS_RULES: PathRule[] = [
  // EmDash OAuth/MCP only — the sole non-Auth0 paths that stay reachable on locked staging.
  // Do not add reader or editorial routes here. See web/docs/STAGING_ACCESS.md.
  // `/.well-known/` also serves Digital Asset Links (`assetlinks.json`) and OAuth metadata.
  { path: '/_emdash', mode: PathMode.Exact },
  { path: '/_emdash/', mode: PathMode.StartsWith },
  { path: '/.well-known/', mode: PathMode.StartsWith },
];

const DEFAULT_MCP_SCOPES = 'content:read content:write media:read media:write schema:read schema:write admin';

function validatePathRules(rules: PathRule[]): void {
  for (const rule of rules) {
    if (rule.mode === PathMode.StartsWith && !rule.path.endsWith('/')) {
      throw new Error(`startsWith rule must end with '/': ${rule.path}`);
    }
  }
}

validatePathRules(AUTH_BYPASS_RULES);

/** Override EmDash default robots.txt so link-preview crawlers can fetch og:image URLs under /_emdash/api/media/file/. */
function buildRobotsTxt(origin: string): string {
	const sitemapUrl = `${origin}/sitemap.xml`;
	return [
		'# Social preview crawlers: allow public media (og:image, etc.) under /_emdash/api/media/file/',
		'# while keeping the rest of /_emdash/ disallowed for these agents.',
		'User-agent: Twitterbot',
		'User-agent: facebookexternalhit',
		'User-agent: Facebot',
		'User-agent: LinkedInBot',
		'Disallow: /_emdash/',
		'Allow: /_emdash/api/media/file/',
		'',
		'User-agent: *',
		'Allow: /',
		'',
		'# Disallow admin and API routes',
		'Disallow: /_emdash/',
		'',
		`Sitemap: ${sitemapUrl}`,
		'',
	].join('\n');
}

function isAuthBypassPath(path: string): boolean {
  return AUTH_BYPASS_RULES.some((rule) => {
    if (rule.mode === PathMode.Exact) {
      return path === rule.path;
    }
    return path.startsWith(rule.path);
  });
}

export const onRequest = defineMiddleware(async (context, next) => {
  const path = context.url.pathname;
  const normalizedPath = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const env = cfEnv as Record<string, string | undefined>;

  if (env.DEBUG_MIDDLEWARE) {
    console.info('[middleware] onRequest called', { path: context.url.pathname, full: context.url.href });
  }

  if (context.request.method === 'GET' && normalizedPath === '/robots.txt') {
    const body = buildRobotsTxt(context.url.origin);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  // VS Code MCP clients may start with an unauthenticated initialize POST.
  // Return OAuth challenge (401) instead of letting downstream CSRF checks emit 403.
  if (normalizedPath === '/_emdash/api/mcp' && context.request.method !== 'GET') {
    const authHeader = context.request.headers.get('authorization')?.trim() ?? '';
    const cookieHeader = context.request.headers.get('cookie')?.trim() ?? '';
    if (!authHeader && !cookieHeader) {
      const resourceMetadata = `${context.url.origin}/.well-known/oauth-protected-resource`;
      return new Response(
        JSON.stringify({
          error: {
            code: 'NOT_AUTHENTICATED',
            message: 'Not authenticated',
          },
        }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': `Bearer resource_metadata="${resourceMetadata}"`,
          },
        },
      );
    }
  }

  // Some OAuth clients use RFC 8414 path variants for issuers/resources with paths.
  // EmDash serves metadata under /_emdash; expose compatibility aliases at root.
  if (
    path === '/.well-known/oauth-authorization-server'
    || path === '/.well-known/oauth-authorization-server/_emdash'
  ) {
    return context.redirect('/_emdash/.well-known/oauth-authorization-server', 302);
  }

  if (
    path === '/.well-known/oauth-protected-resource/_emdash/api/mcp'
  ) {
    return context.redirect('/.well-known/oauth-protected-resource', 302);
  }

  // Some MCP clients do not send scope/slug on authorize, which EmDash rejects.
  // Normalize these query params so OAuth can complete.
  if (path === '/_emdash/oauth/authorize') {
    const url = new URL(context.url.href);
    const scope = url.searchParams.get('scope')?.trim() ?? '';
    const slug = url.searchParams.get('slug')?.trim() ?? '';
    let shouldRedirect = false;

    if (!scope) {
      url.searchParams.set('scope', DEFAULT_MCP_SCOPES);
      shouldRedirect = true;
    }

    if (!slug) {
      url.searchParams.set('slug', 'default');
      shouldRedirect = true;
    }

    if (shouldRedirect) {
      const redirectUrl = `${url.pathname}${url.search}`;
      console.info('[middleware] normalized emdash oauth authorize params', {
        originalUrl: context.url.href,
        redirectUrl,
      });
      return context.redirect(redirectUrl, 302);
    }
  }

  // Always inject a default slug param for /authorize, even if other params are present
  if (path === '/authorize') {
    // Logging for debug
    console.info('[middleware] /authorize hit', { originalUrl: context.url.href });
    const url = new URL(context.url.href);
    url.searchParams.set('slug', 'default'); // Change 'default' if a specific slug is required
    const redirectUrl = '/_emdash/oauth/authorize' + url.search;
    console.info('[middleware] redirecting to', { redirectUrl });
    return context.redirect(redirectUrl, 302);
  }

  // Keep EmDash and MCP OAuth endpoints free of outer Auth0 gating.
  // EmDash handles its own auth and token validation for these routes.
  // Locked staging: NOTHING else is public — reader routes use authorizeReaderApiRequest /
  // requireReaderPageSession (see PUBLIC_READER_PATHS in auth.ts).
  // EmDash/OAuth bypass traffic is never recorded as public page views.
  if (isAuthBypassPath(path)) {
    return next();
  }

  const response = await next();
  // Site analytics: public HTML page views (home, articles, reader pages) only.
  // Aggregates (path / country / bot flag) for /admin/analytics — not analytics of /admin itself.
  // No IPs, UA, or cookies stored. Analytics Engine writes are non-blocking.
  recordPageView(context.request, response);
  return response;
});
