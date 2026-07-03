import type { AstroCookies } from 'astro';
import type { JWTPayload } from 'jose';

import { hasEditorialRole } from './auth';
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

export type NotificationDiagnosticsSession = AdminSessionBase & {
  isEditor: boolean;
};

function buildSession(base: AdminSessionBase, _payload: JWTPayload): NotificationDiagnosticsSession {
  return {
    ...base,
    isEditor: true,
  };
}

export async function requireNotificationDiagnosticsSession(
  context: NotificationDiagnosticsSessionContext,
): Promise<NotificationDiagnosticsSession | Response> {
  return requireAdminPageSession({
    context,
    roleCheck: hasEditorialRole,
    loginNextPath: ADMIN_PATH,
    logPrefix: 'notification-diagnostics-session',
    buildSession,
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
    roleCheck: hasEditorialRole,
    logPrefix: 'notification-diagnostics-session',
    buildSession,
  });
}
