/**
 * POST /api/admin/outage-alert-test: send a [TEST] outage alert email from this environment (PR #198).
 *
 * Auth:
 * - Admin session (same gate as /api/admin/content-export) plus the usual X-CSRF-Token header. The
 *   button on /admin/outage-alerts uses this.
 * - Or, for an operator without a browser session, `Authorization: Bearer <OUTAGE_ALERT_TEST_TOKEN>`.
 *   That Worker secret is optional; when it is unset or shorter than 32 chars the bearer path is
 *   disabled. It can only send the fixed test email to the configured OUTAGE_ALERT_EMAIL_TO.
 *
 * Rate limited to one test per environment per minute. See web/docs/OUTAGE_ALERTS.md.
 */
import type { APIRoute } from 'astro';

import { authorizeAdminApiRequest } from '../../../lib/admin-session';
import { hasAdminRole, readOptionalEnv } from '../../../lib/auth';
import { resolveDeployEnvironmentName } from '../../../lib/deploy-environment';
import { OUTAGE_ALERT_TEST_TOKEN_MIN_LENGTH, timingSafeEqualString } from '../../../lib/outage-alert';
import { sendOutageAlertTestEmail } from '../../../lib/outage-alert-server';

export const prerender = false;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
	});
}

/** Returns the operator label when the bearer token matches, null when absent, or a 401 Response. */
function bearerOperator(request: Request): string | null | Response {
	const header = request.headers.get('authorization') ?? '';
	if (!header.toLowerCase().startsWith('bearer ')) return null;
	const configured = readOptionalEnv('OUTAGE_ALERT_TEST_TOKEN').trim();
	const presented = header.slice(7).trim();
	if (configured.length < OUTAGE_ALERT_TEST_TOKEN_MIN_LENGTH || !timingSafeEqualString(presented, configured)) {
		console.warn('[admin-outage-alert-test] bearer token rejected', { cfRay: request.headers.get('cf-ray') ?? '' });
		return json({ error: 'Unauthorized' }, 401);
	}
	return 'operator token';
}

export const POST: APIRoute = async ({ cookies, request, url }) => {
	let requestedBy: string;
	const operator = bearerOperator(request);
	if (operator instanceof Response) return operator;
	if (operator) {
		requestedBy = operator;
	} else {
		const session = await authorizeAdminApiRequest({
			cookies,
			request,
			url,
			roleCheck: hasAdminRole,
			logPrefix: 'admin-outage-alert-test',
			requireCsrf: true,
		});
		if (session instanceof Response) return session;
		requestedBy = session.displayName || 'admin';
	}

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