import type { AstroCookies } from 'astro';

import { hasAdminRole } from './auth';
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

export type AdminDashboardSession = AdminSessionBase;

export async function requireAdminDashboardSession(
  context: AdminDashboardSessionContext,
): Promise<AdminDashboardSession | Response> {
  return requireAdminPageSession({
    context,
    roleCheck: hasAdminRole,
    loginNextPath: ADMIN_PATH,
    logPrefix: 'admin-dashboard-session',
  });
}
