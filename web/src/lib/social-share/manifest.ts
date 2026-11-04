/**
 * Single source for the ft-social-share plugin's sandbox grants. The plugin's
 * definePlugin() uses these; scripts/test-social-share.mts asserts the
 * astro.config.ts descriptor lists exactly the same values, so a new network
 * can't be allowed in one place and blocked in the other.
 */
import { STAGING_HOSTNAME } from '../homepage-host';
import { BLUESKY_HOST } from './bluesky';
import { PRODUCTION_SITE_ORIGIN } from './policy';
import { X_HOST } from './x';

export const SOCIAL_SHARE_CAPABILITIES = ['content:read', 'network:request'] as const;

/** Bluesky / X API hosts, plus FT origins so the Worker can download the card image for uploadBlob. */
export const SOCIAL_SHARE_ALLOWED_HOSTS = [
	BLUESKY_HOST,
	X_HOST,
	new URL(PRODUCTION_SITE_ORIGIN).hostname,
	STAGING_HOSTNAME,
] as const;
