/**
 * Generic feature switches (PR #198). Pure: registry, parsing, precedence and audit trail.
 * I/O lives in feature-switches-server.ts (KV `SESSION`, never Turso). See web/docs/FEATURE_SWITCHES.md.
 *
 * Effective state, first match wins:
 *   1. admin override (KV, set at /admin/feature-switches)       → source `override`
 *   2. Worker var (`envVar` in wrangler.jsonc, e.g. NOTIFICATIONS_ENABLED=on|off) → source `config`
 *   3. the switch's `defaultEnabled`                              → source `default`
 * and then, if that says "on" but a dependency is down, `auto-off` (e.g. subscriptions DB unavailable).
 * An override can turn a switch off, or back on, but never past an auto-off.
 */

export type FeatureSwitchDefinition = {
	name: string;
	label: string;
	description: string;
	/** Worker var holding the deploy-time default (`on` / `off`). */
	envVar: string;
	/** Used when neither an override nor the Worker var is set. */
	defaultEnabled: boolean;
};

export const FEATURE_SWITCHES = [
	{
		name: 'notifications',
		label: 'Reader notifications',
		description:
			'Push notification sign-up (web and app), the "Get notified" callout, device registration and test pushes. Needs the subscriptions database (Turso).',
		envVar: 'NOTIFICATIONS_ENABLED',
		defaultEnabled: true,
	},
] as const satisfies readonly FeatureSwitchDefinition[];

export type FeatureSwitchName = (typeof FEATURE_SWITCHES)[number]['name'];

export function getFeatureSwitchDefinition(name: string): FeatureSwitchDefinition | undefined {
	return FEATURE_SWITCHES.find((s) => s.name === name);
}

/** `on`/`true`/`1`/`yes` → true, `off`/`false`/`0`/`no` → false, anything else → undefined (unset). */
export function parseSwitchValue(raw: string | undefined | null): boolean | undefined {
	const v = (raw ?? '').trim().toLowerCase();
	if (['on', 'true', '1', 'yes', 'enabled'].includes(v)) return true;
	if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return false;
	return undefined;
}

export type FeatureSwitchOverride = { enabled: boolean; by: string; at: string };

export function parseOverride(raw: string | null | undefined): FeatureSwitchOverride | null {
	if (!raw) return null;
	try {
		const o = JSON.parse(raw) as Partial<FeatureSwitchOverride>;
		if (typeof o.enabled !== 'boolean') return null;
		return { enabled: o.enabled, by: String(o.by ?? 'unknown'), at: String(o.at ?? '') };
	} catch {
		return null;
	}
}

export type FeatureSwitchSource = 'override' | 'config' | 'default' | 'auto-off';

export type FeatureSwitchState = {
	name: string;
	label: string;
	enabled: boolean;
	source: FeatureSwitchSource;
	/** Human-readable explanation of `enabled`, shown on /admin/feature-switches. */
	reason: string;
	envVar: string;
	/** Parsed Worker var (undefined = unset or unrecognised). */
	configured: boolean | undefined;
	override: FeatureSwitchOverride | null;
	autoOffReason: string | null;
};

const onOff = (b: boolean) => (b ? 'on' : 'off');

/** The switch's state before dependencies are considered (override → config → default). */
export function resolveBaseSwitch(
	definition: FeatureSwitchDefinition,
	envRaw: string | undefined,
	override: FeatureSwitchOverride | null,
): Omit<FeatureSwitchState, 'autoOffReason'> {
	const configured = parseSwitchValue(envRaw);
	const common = { name: definition.name, label: definition.label, envVar: definition.envVar, configured, override };
	if (override) {
		return { ...common, enabled: override.enabled, source: 'override', reason: `Admin override: ${onOff(override.enabled)} (by ${override.by}, ${override.at})` };
	}
	if (configured !== undefined) {
		return { ...common, enabled: configured, source: 'config', reason: `${definition.envVar}=${onOff(configured)} (wrangler.jsonc)` };
	}
	return { ...common, enabled: definition.defaultEnabled, source: 'default', reason: `Default: ${onOff(definition.defaultEnabled)} (${definition.envVar} unset)` };
}

/** Apply a dependency check. `autoOffReason` non-null forces the switch off. */
export function applyAutoOff(base: Omit<FeatureSwitchState, 'autoOffReason'>, autoOffReason: string | null): FeatureSwitchState {
	if (base.enabled && autoOffReason) {
		return { ...base, enabled: false, source: 'auto-off', reason: `Automatically off: ${autoOffReason}. (Otherwise: ${base.reason})`, autoOffReason };
	}
	return { ...base, autoOffReason };
}

export function featureSwitchOverrideKey(name: string): string {
	return `ft-feature-switch:v1:${name}`;
}

export function featureSwitchAuditKey(name: string): string {
	return `ft-feature-switch-audit:v1:${name}`;
}

export const FEATURE_SWITCH_AUDIT_MAX = 50;
/** Per-isolate cache of overrides: a change reaches every isolate within this many ms. */
export const FEATURE_SWITCH_CACHE_MS = 30_000;

export type FeatureSwitchAction = 'enable' | 'disable' | 'clear';

export type FeatureSwitchAuditEntry = {
	action: FeatureSwitchAction;
	by: string;
	at: string;
	/** Effective state just before the change. */
	before: { enabled: boolean; source: FeatureSwitchSource };
};

export function parseAudit(raw: string | null | undefined): FeatureSwitchAuditEntry[] {
	if (!raw) return [];
	try {
		const list = JSON.parse(raw);
		return Array.isArray(list) ? (list as FeatureSwitchAuditEntry[]) : [];
	} catch {
		return [];
	}
}

/** Newest first, capped at {@link FEATURE_SWITCH_AUDIT_MAX}. */
export function appendAudit(list: FeatureSwitchAuditEntry[], entry: FeatureSwitchAuditEntry): FeatureSwitchAuditEntry[] {
	return [entry, ...list].slice(0, FEATURE_SWITCH_AUDIT_MAX);
}

export function parseFeatureSwitchAction(raw: unknown): FeatureSwitchAction | null {
	return raw === 'enable' || raw === 'disable' || raw === 'clear' ? raw : null;
}