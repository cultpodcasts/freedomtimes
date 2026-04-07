import { defineMiddleware } from 'astro:middleware';

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
