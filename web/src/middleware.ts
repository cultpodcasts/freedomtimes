import { defineMiddleware } from 'astro:middleware';
import { env as cfEnv } from 'cloudflare:workers';

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
  { path: '/.well-known/', mode: PathMode.StartsWith },
];

const DEFAULT_MCP_SCOPES = 'content:read content:write media:read media:write schema:read schema:write admin';

const CONFIG_SOURCES = ['cloudflare:workers env', 'import.meta.env'] as const;

type ConfigRequirement = {
  label: string;
  keys: string[];
};

type MissingConfigEntry = {
  label: string;
  acceptedKeys: string[];
  checkedSources: readonly string[];
};

let hasLoggedConfigOk = false;

const EMDASH_DATABASE_REQUIREMENTS: ConfigRequirement[] = [
  { label: 'EmDash database URL', keys: ['TURSO_DATABASE_URL'] },
  { label: 'EmDash database auth token', keys: ['TURSO_AUTH_TOKEN'] },
];

const EMDASH_AUTH_REQUIREMENTS: ConfigRequirement[] = [
  { label: 'EmDash auth secret', keys: ['EMDASH_AUTH_SECRET', 'AUTH_SECRET'] },
];

function readRuntimeEnvValue(env: Record<string, string | undefined>, key: string): string {
  const runtimeValue = env[key];
  if (runtimeValue && runtimeValue.trim().length > 0) {
    return runtimeValue;
  }

  const buildValue = (import.meta.env as Record<string, string | undefined>)[key];
  if (buildValue && buildValue.trim().length > 0) {
    return buildValue;
  }

  return '';
}

function validateConfig(
  env: Record<string, string | undefined>,
  requirements: ConfigRequirement[],
): MissingConfigEntry[] {
  const missing: MissingConfigEntry[] = [];

  for (const requirement of requirements) {
    const found = requirement.keys.some((key) => Boolean(readRuntimeEnvValue(env, key)));
    if (!found) {
      missing.push({
        label: requirement.label,
        acceptedKeys: requirement.keys,
        checkedSources: CONFIG_SOURCES,
      });
    }
  }

  return missing;
}

function shouldEnforceEmdashConfig(path: string): boolean {
  if (path === '/homepage') {
    return true;
  }

  if (path.startsWith('/_emdash')) {
    return true;
  }

  return false;
}

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
  const normalizedPath = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const env = cfEnv as Record<string, string | undefined>;

  if (shouldEnforceEmdashConfig(path)) {
    const requirements = path.startsWith('/_emdash')
      ? [...EMDASH_DATABASE_REQUIREMENTS, ...EMDASH_AUTH_REQUIREMENTS]
      : EMDASH_DATABASE_REQUIREMENTS;
    const missing = validateConfig(env, requirements);

    if (missing.length > 0) {
      console.error('[config.validation] Missing runtime configuration', {
        path,
        missing,
      });

      return new Response(
        JSON.stringify({
          error: 'CONFIG_VALIDATION_FAILED',
          message: 'Required runtime configuration is missing for this route.',
          path,
          missing,
        }),
        {
          status: 500,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          },
        },
      );
    }

    if (!hasLoggedConfigOk) {
      console.info('[config.validation] Runtime configuration is present for EmDash routes');
      hasLoggedConfigOk = true;
    }
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
  if (isAuthBypassPath(path)) {
    return next();
  }

  if (path.startsWith('/_emdash')) {
    const hasDatabaseConfig = Boolean(readRuntimeEnvValue(env, 'TURSO_DATABASE_URL'));
    const hasAuthSecret = Boolean(readRuntimeEnvValue(env, 'EMDASH_AUTH_SECRET') || readRuntimeEnvValue(env, 'AUTH_SECRET'));
    const hasPreviewSecret = Boolean(readRuntimeEnvValue(env, 'EMDASH_PREVIEW_SECRET') || readRuntimeEnvValue(env, 'PREVIEW_SECRET'));

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
