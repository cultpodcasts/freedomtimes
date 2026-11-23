/** Deployed environments of the site Worker. */
export type DeployEnvironmentName = 'production' | 'staging' | 'local';

/** Which deployed environment this Worker is, from the request host. Pure; safe on every request. */
export function resolveDeployEnvironmentName(hostname: string): DeployEnvironmentName {
	const host = hostname.trim().toLowerCase();
	if (host === 'freedomtimes.news' || host === 'www.freedomtimes.news') return 'production';
	if (host === 'staging.freedomtimes.news') return 'staging';
	return 'local';
}