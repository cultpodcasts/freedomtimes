import type { AstroCookies } from 'astro';
import type { JWTPayload } from 'jose';

import { hasEditorialRole, hasStaffLoginRole, hasTipsAccess } from './auth';
import {
  requireAdminPageSession,
  type AdminSessionBase,
} from './admin-session';

const ADMIN_PATH = '/admin';

type AdminDashboardSessionContext = {
  cookies: AstroCookies;
  url: URL;
  request: Request;
  redirect: (path: string) => Response;
};

export type AdminDashboardSession = AdminSessionBase & {
  isEditor: boolean;
  isTipsHandler: boolean;
  canAccessTips: boolean;
  canAccessDiagnostics: boolean;
  canAccessCms: boolean;
};

function buildSession(base: AdminSessionBase, payload: JWTPayload): AdminDashboardSession {
  const canAccessTips = hasTipsAccess(payload);
  const canAccessDiagnostics = hasEditorialRole(payload);
  const canAccessCms = hasEditorialRole(payload);

  return {
    ...base,
    isEditor: canAccessDiagnostics,
    isTipsHandler: canAccessTips,
    canAccessTips,
    canAccessDiagnostics,
    canAccessCms,
  };
}

export async function requireAdminDashboardSession(
  context: AdminDashboardSessionContext,
): Promise<AdminDashboardSession | Response> {
  return requireAdminPageSession({
    context,
    roleCheck: hasStaffLoginRole,
    loginNextPath: ADMIN_PATH,
    logPrefix: 'admin-dashboard-session',
    buildSession,
  });
}
