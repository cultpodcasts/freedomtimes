/**
 * Reader notifications availability (PR #198). Pure rules; I/O in notifications-availability-server.ts.
 *
 * Notifications are on only when the `notifications` feature switch is on (admin override →
 * NOTIFICATIONS_ENABLED → default on) AND the subscriptions database (Turso) is usable. When off:
 * no callout, no browser/app prompt or device registration, and the push APIs answer 503
 * `notifications_paused` before touching Turso. Turning it back on (1 Dec) is config only.
 */

export const NOTIFICATIONS_SWITCH = 'notifications';
/** Per-isolate cache of the subscriptions DB probe. */
export const NOTIFICATIONS_HEALTH_CACHE_MS = 5 * 60_000;
export const NOTIFICATIONS_HEALTH_TIMEOUT_MS = 2_000;
export const NOTIFICATIONS_PAUSED_ERROR = 'notifications_paused';
export const NOTIFICATIONS_PAUSED_MESSAGE = 'Notifications are paused right now. Please try again later.';

export function isTruthyFlag(raw: string | undefined): boolean {
	return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

/** Why the subscriptions DB cannot be used, or null when it can (health: null = not checked). */
export function resolveNotificationsAutoOffReason(input: {
	skipTurso: string | undefined;
	subscriptionsUrl: string | undefined;
	health: { ok: true } | { ok: false; message: string } | null;
}): string | null {
	if (isTruthyFlag(input.skipTurso)) return 'FT_SKIP_TURSO is set (Turso is bypassed)';
	if (!(input.subscriptionsUrl ?? '').trim()) return 'the subscriptions database is not configured (TURSO_SUBSCRIPTIONS_DATABASE_URL)';
	if (input.health && !input.health.ok) return `the subscriptions database health check failed (${input.health.message})`;
	return null;
}

/** Public, minimal status for /api/notifications-status (no reasons leak to readers). */
export function publicNotificationsStatus(enabled: boolean): { enabled: boolean; message?: string } {
	return enabled ? { enabled } : { enabled, message: NOTIFICATIONS_PAUSED_MESSAGE };
}

export function notificationsPausedResponse(): Response {
	return new Response(JSON.stringify({ error: NOTIFICATIONS_PAUSED_ERROR, message: NOTIFICATIONS_PAUSED_MESSAGE }), {
		status: 503,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3600' },
	});
}