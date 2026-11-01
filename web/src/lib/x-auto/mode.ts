/**
 * When an automatic X post is allowed to leave the building.
 *
 * `intent` and `api` send only when both are true:
 * - the Worker is the public production one (`SITE_ACCESS_MODE=public`)
 * - `X_AUTO_POST_ALLOW_SEND=yes` (set only in the production wrangler env)
 *
 * A staging smoke test that flips `SITE_ACCESS_MODE` to public still dry-runs,
 * because that flip does not add the allow flag. Anything else (locked staging,
 * local dev, a missing or unknown mode) dry-runs or stays off. Dry-run builds
 * the post and the intent link and sends nothing.
 */
export type XAutoConfiguredMode = 'off' | 'dry-run' | 'intent' | 'api';

export function readConfiguredXAutoMode(env: Record<string, unknown>): XAutoConfiguredMode {
	const raw = typeof env.X_AUTO_POST_MODE === 'string' ? env.X_AUTO_POST_MODE.trim().toLowerCase() : '';
	if (raw === 'off' || raw === 'dry-run' || raw === 'intent' || raw === 'api') return raw;
	return 'dry-run';
}

/** True only on the production Worker that is explicitly allowed to deliver. */
export function xAutoSendAllowed(env: Record<string, unknown>): boolean {
	const access = typeof env.SITE_ACCESS_MODE === 'string' ? env.SITE_ACCESS_MODE.trim().toLowerCase() : '';
	const allow = typeof env.X_AUTO_POST_ALLOW_SEND === 'string' ? env.X_AUTO_POST_ALLOW_SEND.trim().toLowerCase() : '';
	return access === 'public' && allow === 'yes';
}

/** Mode that actually runs. `intent` and `api` collapse to `dry-run` unless sending is allowed. */
export function effectiveXAutoMode(env: Record<string, unknown>): XAutoConfiguredMode {
	const configured = readConfiguredXAutoMode(env);
	if ((configured === 'intent' || configured === 'api') && !xAutoSendAllowed(env)) return 'dry-run';
	return configured;
}
