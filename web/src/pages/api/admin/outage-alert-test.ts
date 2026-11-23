/**
 * POST /api/admin/outage-alert-test: send a [TEST] outage alert email from this environment (PR #198).
 *
 * Auth: admin session only (same gate as /api/admin/content-export) plus the usual X-CSRF-Token
 * header; the button on /admin/outage-alerts uses this. There is no other way in (owner decision).
 *
 * Rate limited to one test per environment per minute. See web/docs/OUTAGE_ALERTS.md.
 */
import type { APIRoute } from 'astro';

import { authorizeAdminApiRequest } from '../../../lib/admin-session';
import { hasAdminRole } from '../../../lib/auth';
import { resolveDeployEnvironmentName } from '../../../lib/deploy-environment';
import { sendOutageAlertTestEmail } from '../../../lib/outage-alert-server';

export const prerender = false;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
	});
}

export const POST: APIRoute = async ({ cookies, request, url }) => {
	const session = await authorizeAdminApiRequest({
		cookies,
		request,
		url,
		roleCheck: hasAdminRole,
		logPrefix: 'admin-outage-alert-test',
		requireCsrf: true,
	});
	if (session instanceof Response) return session;
	const requestedBy = session.displayName || 'admin';

	const environment = resolveDeployEnvironmentName(url.hostname);
	const result = await sendOutageAlertTestEmail({ environment, host: url.host, requestedBy });
	if (result.kind === 'rate-limited') {
		return json(
			{ error: `A test email was sent less than ${result.retryAfterSeconds} s ago.` },
			429,
			{ 'retry-after': String(result.retryAfterSeconds) },
		);
	}
	console.info('[admin-outage-alert-test] done', { environment, requestedBy, ok: result.ok, sent: result.sent });
	return json(
		{
			ok: result.ok,
			environment,
			recipients: result.recipients,
			sent: result.sent,
			failed: result.failed,
			messageIds: result.messageIds,
			...(result.error ? { error: result.error } : {}),
			sentAt: new Date().toISOString(),
		},
		result.ok ? 200 : 502,
	);
};