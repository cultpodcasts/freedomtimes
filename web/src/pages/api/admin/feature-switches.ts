/**
 * Feature switches API (PR #198). Admin role only; POST also needs X-CSRF-Token.
 *   GET  → { switches: [{ description, state, audit }] }
 *   POST { name, action: 'enable' | 'disable' | 'clear' } → { state }  (audit-logged)
 * Overrides live in KV `SESSION` (not Turso) and take effect within ~30 s, with no deploy.
 */
import type { APIRoute } from 'astro';

import { authorizeAdminApiRequest } from '../../../lib/admin-session';
import { hasAdminRole } from '../../../lib/auth';
import { getEffectiveSwitchState, listFeatureSwitchesForAdmin } from '../../../lib/feature-switch-admin';
import { getFeatureSwitchDefinition, parseFeatureSwitchAction } from '../../../lib/feature-switches';
import { setFeatureSwitch } from '../../../lib/feature-switches-server';

export const prerender = false;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private' },
	});
}

export const GET: APIRoute = async ({ cookies, request, url }) => {
	const session = await authorizeAdminApiRequest({ cookies, request, url, roleCheck: hasAdminRole, logPrefix: 'admin-feature-switches' });
	if (session instanceof Response) return session;
	return json({ switches: await listFeatureSwitchesForAdmin() });
};

export const POST: APIRoute = async ({ cookies, request, url }) => {
	const session = await authorizeAdminApiRequest({
		cookies,
		request,
		url,
		roleCheck: hasAdminRole,
		logPrefix: 'admin-feature-switches',
		requireCsrf: true,
	});
	if (session instanceof Response) return session;

	let body: { name?: unknown; action?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'Request body must be JSON: { name, action }.' }, 400);
	}
	const name = typeof body.name === 'string' ? body.name : '';
	const action = parseFeatureSwitchAction(body.action);
	if (!getFeatureSwitchDefinition(name)) return json({ error: 'Unknown feature switch.' }, 404);
	if (!action) return json({ error: "action must be 'enable', 'disable' or 'clear'." }, 400);

	const before = await getEffectiveSwitchState(name);
	try {
		await setFeatureSwitch({ name, action, by: session.displayName || session.requestId, before });
	} catch (error) {
		console.error('[admin-feature-switches] change failed', { name, action, message: String(error) });
		return json({ error: 'Could not save the change.' }, 503);
	}
	return json({ state: await getEffectiveSwitchState(name) });
};