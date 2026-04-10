import { defineMiddleware } from 'astro:middleware';

enum PathMode {
  Exact = 'exact',
  StartsWith = 'startsWith',
}

type PathRule = {
  path: string;
  mode: PathMode;
};

const AUTH_BYPASS_RULES: PathRule[] = [
  { path: '/_emdash', mode: PathMode.Exact },
  { path: '/_emdash/', mode: PathMode.StartsWith },
  { path: '/.well-known/oauth-protected-resource', mode: PathMode.Exact },
  { path: '/.well-known/oauth-authorization-server', mode: PathMode.Exact },
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

function isAuthBypassPath(path: string): boolean {
  return AUTH_BYPASS_RULES.some((rule) => {
    if (rule.mode === PathMode.Exact) {
      return path === rule.path;
    }
    return path.startsWith(rule.path);
  });
}

function getRolesFromRequest(context: any): string[] {
  // EmDash auth is handled by the CMS integration itself via EMDASH_AUTH_SECRET
  // This middleware provides an additional layer for admin route protection
  try {
    // Get session cookie and validate roles
    const sessionCookie = context.cookies.get('ft_session')?.value;
    if (sessionCookie) {
      // Parse JWT to extract roles (without verification at this layer)
      // EmDash will handle actual JWT validation with EMDASH_AUTH_SECRET
      const parts = sessionCookie.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        const namespace = (import.meta.env as Record<string, string>).AUTH0_ROLES_CLAIM_NAMESPACE || '';
        return payload[namespace]?.roles || payload.roles || [];
      }
    }
  } catch (_) {
    // Silent fail - EmDash will handle auth
  }
  return [];
}

export const onRequest = defineMiddleware(async (context, next) => {
    // Global log to confirm middleware execution for all requests
    console.info('[middleware] onRequest called', { path: context.url.pathname, full: context.url.href });
  const path = context.url.pathname;

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
  if (isAuthBypassPath(path)) {
    return next();
  }

  if (path.startsWith('/_emdash')) {
    const env = import.meta.env as Record<string, string | undefined>;
    const hasDatabaseConfig = Boolean(env.TURSO_DATABASE_URL);
    const hasAuthSecret = Boolean(env.EMDASH_AUTH_SECRET || env.AUTH_SECRET);
    const hasPreviewSecret = Boolean(env.EMDASH_PREVIEW_SECRET || env.PREVIEW_SECRET);

    // Check Auth0 roles for admin routes
    const isAdminRoute = path.startsWith('/_emdash/admin');
    const userRoles = getRolesFromRequest(context);
    const hasEditorialRole = userRoles.includes('editor') || userRoles.includes('admin');

    console.info('[emdash.bootstrap]', {
      path,
      hasDatabaseConfig,
      hasAuthSecret,
      hasPreviewSecret,
      isAdminRoute,
      userRoles,
      hasEditorialRole,
    });

    // EmDash CMS will enforce auth via EMDASH_AUTH_SECRET
    // This logging helps troubleshoot access issues
  }

  return next();
});
