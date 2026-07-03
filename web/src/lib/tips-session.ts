import type { AstroCookies } from 'astro';

import { hasTipsAccess } from './auth';
import {
  authorizeAdminApiRequest,
  requireAdminPageSession,
  verifyCsrfToken,
  type AdminSessionBase,
} from './admin-session';

const ADMIN_PATH = '/admin/tips';

type TipsSessionContext = {
  cookies: AstroCookies;
  url: URL;
  request: Request;
  redirect: (path: string) => Response;
};

export type TipsSession = AdminSessionBase;

export async function requireTipsSession(
  context: TipsSessionContext,
): Promise<TipsSession | Response> {
  return requireAdminPageSession({
    context,
    roleCheck: hasTipsAccess,
    loginNextPath: ADMIN_PATH,
    logPrefix: 'tips-session',
  });
}

export async function authorizeTipsApiRequest(params: {
  cookies: AstroCookies;
  request: Request;
  url: URL;
}): Promise<TipsSession | Response> {
  const session = await authorizeAdminApiRequest({
    cookies: params.cookies,
    request: params.request,
    url: params.url,
    roleCheck: hasTipsAccess,
    logPrefix: 'tips-session',
    requireCsrf: true,
  });

  if (session instanceof Response) {
    return session;
  }

  return session;
}

export { verifyCsrfToken };
