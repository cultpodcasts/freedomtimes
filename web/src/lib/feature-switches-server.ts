/**
 * Feature switch I/O (PR #198): overrides + audit trail in KV `SESSION` (an existing namespace; never
 * Turso), a short per-isolate cache, and the Worker var default. Pure rules: feature-switches.ts.
 */
import { env as cfEnv } from 'cloudflare:workers';

import { readOptionalEnv } from './auth';
import {
	appendAudit,
	applyAutoOff,
	FEATURE_SWITCH_CACHE_MS,
	featureSwitchAuditKey,
	featureSwitchOverrideKey,
	getFeatureSwitchDefinition,
	parseAudit,
	parseOverride,
	resolveBaseSwitch,
	type FeatureSwitchAction,
	type FeatureSwitchAuditEntry,
	type FeatureSwitchOverride,
	type FeatureSwitchState,
} from './feature-switches';

type KvLike = {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
};

const overrideCache = new Map<string, { value: FeatureSwitchOverride | null; at: number }>();

function kv(): KvLike | undefined {
	return (cfEnv as Record<string, unknown>).SESSION as KvLike | undefined;
}

function definitionOrThrow(name: string) {
	const definition = getFeatureSwitchDefinition(name);
	if (!definition) throw new Error(`Unknown feature switch: ${name}`);
	return definition;
}

async function readOverride(name: string): Promise<FeatureSwitchOverride | null> {
	const cached = overrideCache.get(name);
	if (cached && Date.now() - cached.at < FEATURE_SWITCH_CACHE_MS) return cached.value;
	let value: FeatureSwitchOverride | null = null;
	try {
		value = parseOverride((await kv()?.get(featureSwitchOverrideKey(name))) ?? null);
	} catch (error) {
		// KV down: fall back to the Worker var default rather than failing the page.
		console.warn('[feature-switch] override read failed; using config/default', { name, message: String(error) });
	}
	overrideCache.set(name, { value, at: Date.now() });
	return value;
}

/** Override → Worker var → default (no dependency checks). */
export async function getBaseFeatureSwitch(name: string) {
	const definition = definitionOrThrow(name);
	return resolveBaseSwitch(definition, readOptionalEnv(definition.envVar), await readOverride(name));
}

/**
 * Effective state. `autoOff` runs only when the switch would otherwise be on (so a switched-off
 * feature never probes its dependency) and returns a reason string to force it off.
 */
export async function getFeatureSwitchState(
	name: string,
	autoOff?: () => Promise<string | null>,
): Promise<FeatureSwitchState> {
	const base = await getBaseFeatureSwitch(name);
	return applyAutoOff(base, base.enabled && autoOff ? await autoOff() : null);
}

export async function readFeatureSwitchAudit(name: string): Promise<FeatureSwitchAuditEntry[]> {
	definitionOrThrow(name);
	try {
		return parseAudit((await kv()?.get(featureSwitchAuditKey(name))) ?? null);
	} catch {
		return [];
	}
}

/** enable / disable writes an override; clear deletes it (back to the Worker var). Audit-logged. */
export async function setFeatureSwitch(params: {
	name: string;
	action: FeatureSwitchAction;
	by: string;
	before: FeatureSwitchState;
}): Promise<void> {
	definitionOrThrow(params.name);
	const store = kv();
	if (!store) throw new Error('KV binding SESSION is missing; feature switches cannot be changed.');
	const at = new Date().toISOString();
	const key = featureSwitchOverrideKey(params.name);
	if (params.action === 'clear') await store.delete(key);
	else await store.put(key, JSON.stringify({ enabled: params.action === 'enable', by: params.by, at } satisfies FeatureSwitchOverride));
	const entry: FeatureSwitchAuditEntry = {
		action: params.action,
		by: params.by,
		at,
		before: { enabled: params.before.enabled, source: params.before.source },
	};
	await store.put(featureSwitchAuditKey(params.name), JSON.stringify(appendAudit(await readFeatureSwitchAudit(params.name), entry)));
	overrideCache.delete(params.name);
	// Durable audit line in Workers Logs too (KV keeps the last 50).
	console.info('[feature-switch] changed', { name: params.name, ...entry });
}