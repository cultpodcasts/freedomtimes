/**
 * Notifications availability with I/O (PR #198): feature switch (KV) + subscriptions DB probe.
 * The probe runs only when the switch is otherwise on, at most once per isolate per 5 minutes, so a
 * switched-off feature never spends Turso quota.
 */
import { readOptionalEnv } from './auth';
import { getFeatureSwitchState } from './feature-switches-server';
import type { FeatureSwitchState } from './feature-switches';
import {
	NOTIFICATIONS_HEALTH_CACHE_MS,
	NOTIFICATIONS_HEALTH_TIMEOUT_MS,
	NOTIFICATIONS_SWITCH,
	resolveNotificationsAutoOffReason,
} from './notifications-availability';

type Health = { ok: true } | { ok: false; message: string };
let healthCache: { value: Health; at: number } | undefined;

async function probeSubscriptionsDb(): Promise<Health> {
	if (healthCache && Date.now() - healthCache.at < NOTIFICATIONS_HEALTH_CACHE_MS) return healthCache.value;
	let value: Health;
	let client: { close(): void } | undefined;
	try {
		const { createSubscriptionsDb } = await import('./subscriptions-db');
		const created = createSubscriptionsDb();
		client = created.client;
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`timed out after ${NOTIFICATIONS_HEALTH_TIMEOUT_MS} ms`)), NOTIFICATIONS_HEALTH_TIMEOUT_MS),
		);
		await Promise.race([created.client.execute('SELECT 1'), timeout]);
		value = { ok: true };
	} catch (error) {
		value = { ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
		console.warn('[notifications] subscriptions DB unavailable; notifications auto-off', { message: value.message });
	} finally {
		client?.close();
	}
	healthCache = { value, at: Date.now() };
	return value;
}

/**
 * Effective notifications state. `healthCheck: false` (page renders) uses config + override only;
 * `true` (APIs, /admin) also probes the subscriptions DB.
 */
export async function getNotificationsState(options: { healthCheck?: boolean } = {}): Promise<FeatureSwitchState> {
	return getFeatureSwitchState(NOTIFICATIONS_SWITCH, async () => {
		const configOnly = resolveNotificationsAutoOffReason({
			skipTurso: readOptionalEnv('FT_SKIP_TURSO'),
			subscriptionsUrl: readOptionalEnv('TURSO_SUBSCRIPTIONS_DATABASE_URL'),
			health: null,
		});
		if (configOnly || !options.healthCheck) return configOnly;
		return resolveNotificationsAutoOffReason({
			skipTurso: undefined,
			subscriptionsUrl: 'configured',
			health: await probeSubscriptionsDb(),
		});
	});
}

/** For callers that just need on/off (never throws; a failure counts as off). */
export async function notificationsEnabled(options: { healthCheck?: boolean } = {}): Promise<boolean> {
	try {
		return (await getNotificationsState(options)).enabled;
	} catch (error) {
		console.warn('[notifications] availability check failed; treating as off', { message: String(error) });
		return false;
	}
}