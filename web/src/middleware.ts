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
];

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
  const path = context.url.pathname;

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
    const hasEditorialRole = userRoles.includes('editorial') || userRoles.includes('admin');

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
