/**
 * I/O side of the 5xx outage alert (policy: src/lib/outage-alert.ts). Called from src/middleware.ts
 * via `waitUntil`, so it never delays or changes the error response.
 *
 * Channels (both optional, both configured by Worker secrets; see web/docs/OUTAGE_ALERTS.md):
 * 1. Email (primary, no Turso): Cloudflare Email Sending through the existing `send_email` binding
 *    EMAIL (from noreply@freedomtimes.news) to every address in `OUTAGE_ALERT_EMAIL_TO`.
 * 2. App/web push (best effort): devices registered in the subscriptions DB by the Auth0 users in
 *    `OUTAGE_ALERT_PUSH_USER_IDS`. That DB is on Turso, so this channel is down whenever Turso is;
 *    a failure is logged and never blocks the email.
 *
 * Dedupe: KV `SESSION` key `ft-outage-alert:v1:<env>` with a TTL of one window, plus a per-isolate
 * timestamp so an outage storm does not hit KV on every request.
 */
import { env as cfEnv } from 'cloudflare:workers';
import { and, eq, inArray } from 'drizzle-orm';

import {
	createApnsToken,
	createApplicationServerKeys,
	createGoogleAccessToken,
	deliverToStoredTarget,
	parseStoredTarget,
	readAndroidPushConfig,
	readIosPushConfig,
	readWebPushConfig,
} from '../../../shared/push/deliverPushNotification.mjs';
import { readOptionalEnv } from './auth';
import {
	buildOutageAlertEmail,
	buildOutageAlertPush,
	buildOutageAlertTestEmail,
	OUTAGE_ALERT_TEST_WINDOW_SECONDS,
	outageAlertTestKey,
	OUTAGE_ALERT_FROM,
	OUTAGE_ALERT_WINDOW_SECONDS,
	outageAlertDedupeKey,
	outageAlertsEnabled,
	parseEmailRecipients,
	parseList,
	type OutageAlertEvent,
} from './outage-alert';

type KvLike = {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};
type SendEmailLike = { send(message: Record<string, unknown>): Promise<unknown> };

let lastAlertAtMs = 0;

function binding<T>(name: string): T | undefined {
	return (cfEnv as Record<string, unknown>)[name] as T | undefined;
}

/** True when this isolate/KV already alerted inside the window; otherwise claims the window. */
async function claimAlertWindow(event: OutageAlertEvent): Promise<boolean> {
	const now = event.at.getTime();
	if (now - lastAlertAtMs < OUTAGE_ALERT_WINDOW_SECONDS * 1000) return false;
	lastAlertAtMs = now;
	const kv = binding<KvLike>('SESSION');
	if (!kv) return true;
	try {
		const key = outageAlertDedupeKey(event.environment);
		if (await kv.get(key)) return false;
		await kv.put(key, event.at.toISOString(), { expirationTtl: OUTAGE_ALERT_WINDOW_SECONDS });
	} catch (error) {
		console.warn('[ft-outage-alert] KV dedupe unavailable; alerting anyway', { message: String(error) });
	}
	return true;
}

export type OutageEmailResult = {
	ok: boolean;
	recipients: number;
	sent: number;
	failed: number;
	/** Why nothing was attempted (missing config) or the first send error. */
	error?: string;
	/** Message ids returned by Cloudflare Email Sending, when it returns one. */
	messageIds: string[];
};

/** Sends one message to every OUTAGE_ALERT_EMAIL_TO recipient through the EMAIL binding. Never throws. */
async function sendAlertEmail(
	message: { subject: string; text: string; html: string },
	logContext: Record<string, unknown>,
): Promise<OutageEmailResult> {
	const recipients = parseEmailRecipients(readOptionalEnv('OUTAGE_ALERT_EMAIL_TO'));
	if (recipients.length === 0) {
		console.error('[ft-outage-alert] NOT SENT by email: OUTAGE_ALERT_EMAIL_TO is not set on this Worker', logContext);
		return { ok: false, recipients: 0, sent: 0, failed: 0, error: 'OUTAGE_ALERT_EMAIL_TO is not set', messageIds: [] };
	}
	const email = binding<SendEmailLike>('EMAIL');
	if (!email || typeof email.send !== 'function') {
		console.error('[ft-outage-alert] NOT SENT by email: send_email binding EMAIL missing', logContext);
		return { ok: false, recipients: recipients.length, sent: 0, failed: 0, error: 'send_email binding EMAIL missing', messageIds: [] };
	}
	const results = await Promise.all(
		recipients.map(async (to) => {
			try {
				const sent = (await email.send({ from: OUTAGE_ALERT_FROM, to, subject: message.subject, text: message.text, html: message.html })) as
					| { messageId?: string }
					| undefined;
				const messageId = typeof sent?.messageId === 'string' ? sent.messageId : '';
				console.info('[ft-outage-alert] email accepted by Cloudflare', { ...logContext, messageId });
				return { ok: true as const, messageId };
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error('[ft-outage-alert] email failed', { ...logContext, message: msg });
				return { ok: false as const, error: msg };
			}
		}),
	);
	const sent = results.filter((r) => r.ok).length;
	const firstError = results.find((r) => !r.ok);
	return {
		ok: sent === recipients.length,
		recipients: recipients.length,
		sent,
		failed: recipients.length - sent,
		error: firstError && !firstError.ok ? firstError.error : undefined,
		messageIds: results.flatMap((r) => (r.ok && r.messageId ? [r.messageId] : [])),
	};
}

async function sendEmailAlerts(event: OutageAlertEvent): Promise<void> {
	await sendAlertEmail(buildOutageAlertEmail(event), { status: event.status, environment: event.environment });
}

export type OutageAlertTestResult =
	| ({ kind: 'sent' } & OutageEmailResult)
	| { kind: 'rate-limited'; retryAfterSeconds: number };

/**
 * Admin "send a test alert" (POST /api/admin/outage-alert-test). Same EMAIL binding, sender and
 * recipients as a real alert, a [TEST] subject, no push. Ignores OUTAGE_ALERTS (so it works where
 * real alerts are off) but is limited to one per environment per minute.
 */
export async function sendOutageAlertTestEmail(params: {
	environment: OutageAlertEvent['environment'];
	host: string;
	requestedBy: string;
	at?: Date;
}): Promise<OutageAlertTestResult> {
	const at = params.at ?? new Date();
	const kv = binding<KvLike>('SESSION');
	const key = outageAlertTestKey(params.environment);
	if (kv) {
		try {
			if (await kv.get(key)) return { kind: 'rate-limited', retryAfterSeconds: OUTAGE_ALERT_TEST_WINDOW_SECONDS };
			await kv.put(key, at.toISOString(), { expirationTtl: OUTAGE_ALERT_TEST_WINDOW_SECONDS });
		} catch (error) {
			console.warn('[ft-outage-alert] test rate limit unavailable', { message: String(error) });
		}
	}
	const message = buildOutageAlertTestEmail({
		environment: params.environment,
		host: params.host,
		at,
		requestedBy: params.requestedBy,
		alertsEnabled: outageAlertsEnabled(params.environment, readOptionalEnv('OUTAGE_ALERTS')),
		contentBackend: readOptionalEnv('FT_CONTENT_BACKEND').trim() || 'turso',
	});
	const result = await sendAlertEmail(message, { test: true, environment: params.environment, requestedBy: params.requestedBy });
	console.info('[ft-outage-alert] test email result', {
		environment: params.environment,
		ok: result.ok,
		recipients: result.recipients,
		sent: result.sent,
		failed: result.failed,
	});
	return { kind: 'sent', ...result };
}

function firstEnv(...keys: string[]): string {
	for (const key of keys) {
		const value = readOptionalEnv(key).trim();
		if (value) return value;
	}
	return '';
}

async function sendPushAlerts(event: OutageAlertEvent, siteOrigin: string): Promise<void> {
	const userIds = parseList(readOptionalEnv('OUTAGE_ALERT_PUSH_USER_IDS'));
	if (userIds.length === 0) return;
	const webPushConfig = readWebPushConfig({
		PUSH_VAPID_PUBLIC_KEY: firstEnv('PUSH_VAPID_PUBLIC_KEY', 'PUSH_SUBSCRIBE_PUBLIC_KEY', 'PUSH_STAGING_SUBSCRIBE_PUBLIC_KEY'),
		PUSH_VAPID_PRIVATE_KEY: firstEnv('PUSH_VAPID_PRIVATE_KEY', 'PUSH_PRODUCTION_VAPID_PRIVATE_KEY', 'PUSH_STAGING_VAPID_PRIVATE_KEY'),
		PUSH_VAPID_SUBJECT: firstEnv('PUSH_VAPID_SUBJECT', 'PUSH_PRODUCTION_VAPID_SUBJECT', 'PUSH_STAGING_VAPID_SUBJECT'),
	});
	const androidPushConfig = readAndroidPushConfig({
		PUSH_ANDROID_FCM_PROJECT_ID: firstEnv('PUSH_ANDROID_FCM_PROJECT_ID', 'PUSH_PRODUCTION_ANDROID_FCM_PROJECT_ID', 'PUSH_STAGING_ANDROID_FCM_PROJECT_ID'),
		PUSH_ANDROID_FCM_CLIENT_EMAIL: firstEnv('PUSH_ANDROID_FCM_CLIENT_EMAIL', 'PUSH_PRODUCTION_ANDROID_FCM_CLIENT_EMAIL', 'PUSH_STAGING_ANDROID_FCM_CLIENT_EMAIL'),
		PUSH_ANDROID_FCM_PRIVATE_KEY: firstEnv('PUSH_ANDROID_FCM_PRIVATE_KEY', 'PUSH_PRODUCTION_ANDROID_FCM_PRIVATE_KEY', 'PUSH_STAGING_ANDROID_FCM_PRIVATE_KEY'),
		PUSH_ANDROID_FCM_CHANNEL_ID: firstEnv('PUSH_ANDROID_FCM_CHANNEL_ID'),
	});
	const iosPushConfig = readIosPushConfig({
		PUSH_IOS_APNS_TEAM_ID: firstEnv('PUSH_IOS_APNS_TEAM_ID'),
		PUSH_IOS_APNS_KEY_ID: firstEnv('PUSH_IOS_APNS_KEY_ID'),
		PUSH_IOS_APNS_PRIVATE_KEY: firstEnv('PUSH_IOS_APNS_PRIVATE_KEY'),
		PUSH_IOS_APNS_BUNDLE_ID: firstEnv('PUSH_IOS_APNS_BUNDLE_ID'),
		PUSH_IOS_APNS_HOST: firstEnv('PUSH_IOS_APNS_HOST'),
	});
	if (!webPushConfig && !androidPushConfig && !iosPushConfig) {
		console.warn('[ft-outage-alert] push skipped: no web/Android/iOS push credentials on this Worker');
		return;
	}

	// Lazy import: the subscriptions DB client (libsql/Turso) loads only when push is configured.
	const { createSubscriptionsDb, pushSubscriptionsTable } = await import('./subscriptions-db');
	let client: { close(): void } | undefined;
	try {
		const created = createSubscriptionsDb();
		client = created.client;
		const rows = await created.db
			.select({ subscriptionJson: pushSubscriptionsTable.subscriptionJson })
			.from(pushSubscriptionsTable)
			.where(and(inArray(pushSubscriptionsTable.userId, userIds), eq(pushSubscriptionsTable.active, 1)))
			.limit(20);
		const payload = buildOutageAlertPush(event, siteOrigin);
		let sent = 0;
		for (const row of rows) {
			const target = parseStoredTarget(row.subscriptionJson);
			if (!target) continue;
			const result = await deliverToStoredTarget({
				target,
				payload,
				webPushConfig,
				androidPushConfig,
				iosPushConfig,
				getApplicationServerKeys: () => createApplicationServerKeys(webPushConfig),
				getGoogleAccessToken: () => createGoogleAccessToken(androidPushConfig),
				getApnsToken: () => createApnsToken(iosPushConfig),
			});
			if (result.ok) sent += 1;
		}
		console.info('[ft-outage-alert] push delivered', { devices: rows.length, sent });
	} catch (error) {
		// Expected while Turso is blocked: the email above is the channel that must work.
		console.warn('[ft-outage-alert] push failed (subscriptions DB on Turso)', {
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		client?.close();
	}
}

/** Fire-and-forget entry point. Never throws. */
export async function sendOutageAlert(event: OutageAlertEvent, siteOrigin: string): Promise<void> {
	try {
		if (!outageAlertsEnabled(event.environment, readOptionalEnv('OUTAGE_ALERTS'))) return;
		console.error('[ft-outage-alert] 5xx served', {
			status: event.status,
			environment: event.environment,
			cfRay: event.cfRay,
			contentStoreUnavailable: event.contentStoreUnavailable,
		});
		if (!(await claimAlertWindow(event))) return;
		await Promise.allSettled([sendEmailAlerts(event), sendPushAlerts(event, siteOrigin)]);
	} catch (error) {
		console.error('[ft-outage-alert] alert pipeline failed', { message: String(error) });
	}
}