/**
 * Admin view model for /admin/feature-switches (PR #198): every registered switch with its effective
 * state, why, and recent audit entries. Switch-specific dependency checks are registered here.
 */
import { FEATURE_SWITCHES, type FeatureSwitchAuditEntry, type FeatureSwitchState } from './feature-switches';
import { getFeatureSwitchState, readFeatureSwitchAudit } from './feature-switches-server';
import { NOTIFICATIONS_SWITCH } from './notifications-availability';
import { getNotificationsState } from './notifications-availability-server';

export type FeatureSwitchAdminRow = {
	description: string;
	state: FeatureSwitchState;
	audit: FeatureSwitchAuditEntry[];
};

/** Effective state with the switch's own dependency checks (health probes included). */
export async function getEffectiveSwitchState(name: string): Promise<FeatureSwitchState> {
	if (name === NOTIFICATIONS_SWITCH) return getNotificationsState({ healthCheck: true });
	return getFeatureSwitchState(name);
}

export async function listFeatureSwitchesForAdmin(): Promise<FeatureSwitchAdminRow[]> {
	return Promise.all(
		FEATURE_SWITCHES.map(async (definition) => ({
			description: definition.description,
			state: await getEffectiveSwitchState(definition.name),
			audit: (await readFeatureSwitchAudit(definition.name)).slice(0, 10),
		})),
	);
}