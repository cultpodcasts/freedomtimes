/**
 * PR #198: generic feature switches + the reader notifications gate. Synthetic data only: no KV,
 * no Turso; pure rules plus source checks on the wiring.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	appendAudit,
	applyAutoOff,
	FEATURE_SWITCH_AUDIT_MAX,
	FEATURE_SWITCHES,
	featureSwitchAuditKey,
	featureSwitchOverrideKey,
	getFeatureSwitchDefinition,
	parseAudit,
	parseFeatureSwitchAction,
	parseOverride,
	parseSwitchValue,
	resolveBaseSwitch,
	type FeatureSwitchAuditEntry,
} from '../src/lib/feature-switches.ts';
import { parseJsonc } from './lib/worker-placement-check.mjs';
import {
	NOTIFICATIONS_PAUSED_ERROR,
	notificationsPausedResponse,
	publicNotificationsStatus,
	resolveNotificationsAutoOffReason,
} from '../src/lib/notifications-availability.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const notifications = getFeatureSwitchDefinition('notifications')!;

describe('feature switch registry', () => {
	it('notifications is registered with NOTIFICATIONS_ENABLED, default on', () => {
		assert.ok(notifications);
		assert.equal(notifications.envVar, 'NOTIFICATIONS_ENABLED');
		assert.equal(notifications.defaultEnabled, true);
		assert.equal(new Set(FEATURE_SWITCHES.map((s) => s.name)).size, FEATURE_SWITCHES.length, 'unique names');
		assert.equal(getFeatureSwitchDefinition('nope'), undefined);
	});
	it('parseSwitchValue', () => {
		for (const v of ['on', 'TRUE', '1', 'yes']) assert.equal(parseSwitchValue(v), true, v);
		for (const v of ['off', 'false', '0', 'No']) assert.equal(parseSwitchValue(v), false, v);
		for (const v of ['', undefined, null, 'maybe']) assert.equal(parseSwitchValue(v), undefined, String(v));
	});
	it('KV keys are namespaced and versioned', () => {
		assert.equal(featureSwitchOverrideKey('notifications'), 'ft-feature-switch:v1:notifications');
		assert.equal(featureSwitchAuditKey('notifications'), 'ft-feature-switch-audit:v1:notifications');
	});
});

describe('precedence: override → config → default, then auto-off', () => {
	const override = (enabled: boolean) => ({ enabled, by: 'Admin A', at: '2026-11-23T14:00:00.000Z' });
	it('default when nothing is set', () => {
		const s = resolveBaseSwitch(notifications, undefined, null);
		assert.equal(s.enabled, true);
		assert.equal(s.source, 'default');
	});
	it('Worker var wins over default', () => {
		const s = resolveBaseSwitch(notifications, 'off', null);
		assert.equal(s.enabled, false);
		assert.equal(s.source, 'config');
		assert.match(s.reason, /NOTIFICATIONS_ENABLED=off/);
	});
	it('admin override wins over the Worker var, both ways', () => {
		assert.equal(resolveBaseSwitch(notifications, 'off', override(true)).enabled, true);
		assert.equal(resolveBaseSwitch(notifications, 'on', override(false)).enabled, false);
		assert.match(resolveBaseSwitch(notifications, 'off', override(true)).reason, /Admin override: on \(by Admin A/);
	});
	it('auto-off beats an "on" override; it never turns a switch on', () => {
		const on = applyAutoOff(resolveBaseSwitch(notifications, 'off', override(true)), 'the subscriptions database health check failed (blocked)');
		assert.equal(on.enabled, false);
		assert.equal(on.source, 'auto-off');
		assert.match(on.reason, /Automatically off: the subscriptions database health check failed/);
		const off = applyAutoOff(resolveBaseSwitch(notifications, 'off', null), 'anything');
		assert.equal(off.source, 'config', 'already off: reported as config, not auto-off');
		assert.equal(applyAutoOff(resolveBaseSwitch(notifications, 'on', null), null).enabled, true);
	});
	it('parseOverride rejects junk', () => {
		assert.deepEqual(parseOverride('{"enabled":false,"by":"x","at":"t"}'), { enabled: false, by: 'x', at: 't' });
		assert.equal(parseOverride('{"enabled":"yes"}'), null);
		assert.equal(parseOverride('not json'), null);
		assert.equal(parseOverride(null), null);
	});
});

describe('audit trail', () => {
	const entry = (i: number): FeatureSwitchAuditEntry => ({ action: i % 2 ? 'enable' : 'disable', by: `Admin ${i}`, at: `2026-11-23T14:${String(i % 60).padStart(2, '0')}:00Z`, before: { enabled: false, source: 'config' } });
	it('newest first, capped', () => {
		let list: FeatureSwitchAuditEntry[] = [];
		for (let i = 0; i < FEATURE_SWITCH_AUDIT_MAX + 5; i += 1) list = appendAudit(list, entry(i));
		assert.equal(list.length, FEATURE_SWITCH_AUDIT_MAX);
		assert.equal(list[0].by, `Admin ${FEATURE_SWITCH_AUDIT_MAX + 4}`);
	});
	it('parseAudit tolerates bad data; actions are validated', () => {
		assert.deepEqual(parseAudit('{"x":1}'), []);
		assert.deepEqual(parseAudit('oops'), []);
		assert.equal(parseFeatureSwitchAction('enable'), 'enable');
		assert.equal(parseFeatureSwitchAction('clear'), 'clear');
		assert.equal(parseFeatureSwitchAction('drop table'), null);
	});
});

describe('notifications auto-off', () => {
	const url = 'libsql://example-subscriptions.invalid';
	it('FT_SKIP_TURSO, missing URL or failed health check → off with a reason', () => {
		assert.match(resolveNotificationsAutoOffReason({ skipTurso: '1', subscriptionsUrl: url, health: null })!, /FT_SKIP_TURSO/);
		assert.match(resolveNotificationsAutoOffReason({ skipTurso: '', subscriptionsUrl: '', health: null })!, /not configured/);
		assert.match(resolveNotificationsAutoOffReason({ skipTurso: undefined, subscriptionsUrl: url, health: { ok: false, message: 'SQL read operations are forbidden' } })!, /health check failed \(SQL read operations are forbidden\)/);
	});
	it('healthy (or not checked) → null', () => {
		assert.equal(resolveNotificationsAutoOffReason({ skipTurso: '0', subscriptionsUrl: url, health: { ok: true } }), null);
		assert.equal(resolveNotificationsAutoOffReason({ skipTurso: undefined, subscriptionsUrl: url, health: null }), null);
	});
	it('public status never leaks reasons; paused API answer is a clean 503', async () => {
		assert.deepEqual(publicNotificationsStatus(true), { enabled: true });
		assert.deepEqual(Object.keys(publicNotificationsStatus(false)).sort(), ['enabled', 'message']);
		const r = notificationsPausedResponse();
		assert.equal(r.status, 503);
		assert.equal(r.headers.get('retry-after'), '3600');
		assert.equal(((await r.json()) as { error: string }).error, NOTIFICATIONS_PAUSED_ERROR);
	});
});

describe('wiring (source checks)', () => {
	it('wrangler.jsonc: NOTIFICATIONS_ENABLED=off on production and staging', () => {
		const cfg = parseJsonc(read('../wrangler.jsonc')) as { env: Record<string, { vars: Record<string, string> }> };
		assert.equal(cfg.env.production.vars.NOTIFICATIONS_ENABLED, 'off');
		assert.equal(cfg.env.staging.vars.NOTIFICATIONS_ENABLED, 'off');
	});
	it('push / test-push / diagnostics APIs return 503 before any Turso access', () => {
		for (const [file, turso] of [
			['../src/pages/api/push-subscriptions.ts', 'upsertPushSubscription('],
			['../src/pages/api/push-test-notification.ts', 'sendReaderTestPushNotification'],
			['../src/pages/api/notification-diagnostics.ts', 'verifyTurnstileToken('],
		] as const) {
			const src = read(file);
			const gate = src.indexOf('if (!(await notificationsEnabled({ healthCheck: true }))) {');
			assert.ok(gate > 0, `${file}: gate`);
			assert.match(src.slice(gate, gate + 120), /return notificationsPausedResponse\(\);/);
			const body = src.slice(src.indexOf('export const POST'));
			const firstWork = body.indexOf(turso);
			assert.ok(firstWork === -1 || body.indexOf('notificationsEnabled(') < firstWork, `${file}: gate before work`);
		}
	});
	it('the reader callout only renders when notifications are on', () => {
		const view = read('../src/components/EmDashContentView.astro');
		assert.match(view, /const showNotificationsCallout = await notificationsEnabled\(\);/);
		assert.match(view, /\{showNotificationsCallout && <PushNotificationsCallout \/>\}/);
		assert.doesNotMatch(view, /^\s*<PushNotificationsCallout \/>/m);
	});
	it('web + native bridges ask /api/notifications-status before prompting or registering', () => {
		const dn = read('../src/lib/device-notifications.ts');
		assert.match(dn, /fetch\('\/api\/notifications-status'/);
		for (const fn of ['export async function initializeNativePushBridge', 'export async function ensureBrowserPushSubscriptionSynced', 'export async function enableNotificationsForCurrentDevice']) {
			const body = dn.slice(dn.indexOf(fn), dn.indexOf(fn) + 700);
			assert.match(body, /await areNotificationsAvailable\(\)/, fn);
		}
		const native = dn.slice(dn.indexOf('export async function initializeNativePushBridge'));
		assert.ok(native.indexOf('areNotificationsAvailable()') < native.indexOf("PushNotifications.addListener('registration'"), 'native: gate before registering listeners');
	});
	it('admin API: admin role for GET and POST, CSRF on POST; overrides in KV SESSION, not Turso', () => {
		const api = read('../src/pages/api/admin/feature-switches.ts');
		assert.equal((api.match(/roleCheck: hasAdminRole/g) ?? []).length, 2);
		assert.match(api, /requireCsrf: true/);
		assert.ok(api.indexOf('authorizeAdminApiRequest(') < api.indexOf('setFeatureSwitch('));
		const server = read('../src/lib/feature-switches-server.ts');
		assert.match(server, /\.SESSION as KvLike/);
		assert.doesNotMatch(server, /^import .*(subscriptions-db|@libsql|turso)/im);
		assert.match(server, /console\.info\('\[feature-switch\] changed'/, 'audit line in Worker logs');
		const page = read('../src/pages/admin/feature-switches.astro');
		assert.match(page, /requireAdminPageSession\(\{[\s\S]*roleCheck: hasAdminRole,/);
		assert.match(page, /'X-CSRF-Token': csrfToken/);
		assert.match(read('../src/pages/admin/index.astro'), /href: '\/admin\/feature-switches'/);
	});
	it('outage alert push is skipped while notifications are off', () => {
		const s = read('../src/lib/outage-alert-server.ts');
		assert.match(s, /if \(!\(await notificationsEnabled\(\)\)\) \{\s*console\.warn\('\[ft-outage-alert\] push skipped/);
	});
});