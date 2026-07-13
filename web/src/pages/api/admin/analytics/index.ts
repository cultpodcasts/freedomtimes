import type { APIRoute } from 'astro';

import { authorizeAdminApiRequest } from '../../../../lib/admin-session';
import { hasAdminRole } from '../../../../lib/auth';
import {
  loadAdminAnalytics,
  parseAnalyticsPathFilter,
  parseAnalyticsRange,
} from '../../../../lib/page-view-analytics';

export const prerender = false;

export const GET: APIRoute = async ({ cookies, request, url }) => {
  const session = await authorizeAdminApiRequest({
    cookies,
    request,
    url,
    roleCheck: hasAdminRole,
    logPrefix: 'admin-analytics',
  });

  if (session instanceof Response) {
    return session;
  }

  const range = parseAnalyticsRange(url.searchParams.get('range'));
  const includeBots = url.searchParams.get('includeBots') === '1';
  const path = parseAnalyticsPathFilter(url.searchParams.get('path'));

  const analytics = await loadAdminAnalytics({
    range,
    excludeBots: !includeBots,
    path,
  });

  return json(
    {
      ...analytics,
      requestId: session.requestId,
    },
    analytics.error && !analytics.configured ? 503 : 200,
  );
};

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
