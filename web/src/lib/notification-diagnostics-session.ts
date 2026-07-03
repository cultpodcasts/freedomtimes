import type { AstroCookies } from 'astro';

import { hasAdminRole } from './auth';
import {
  authorizeAdminApiRequest,
  requireAdminPageSession,
  type AdminSessionBase,
} from './admin-session';

const ADMIN_PATH = '/admin/notification-diagnostics';

type NotificationDiagnosticsSessionContext = {
  cookies: AstroCookies;
  url: URL;
  request: Request;
  redirect: (path: string) => Response;
};

export type NotificationDiagnosticsSession = AdminSessionBase;

export async function requireNotificationDiagnosticsSession(
  context: NotificationDiagnosticsSessionContext,
): Promise<NotificationDiagnosticsSession | Response> {
  return requireAdminPageSession({
    context,
    roleCheck: hasAdminRole,
    loginNextPath: ADMIN_PATH,
    logPrefix: 'notification-diagnostics-session',
  });
}

export async function authorizeNotificationDiagnosticsApiRequest(params: {
  cookies: AstroCookies;
  request: Request;
  url: URL;
}): Promise<NotificationDiagnosticsSession | Response> {
  return authorizeAdminApiRequest({
    cookies: params.cookies,
    request: params.request,
    url: params.url,
    roleCheck: hasAdminRole,
    logPrefix: 'notification-diagnostics-session',
  });
}
