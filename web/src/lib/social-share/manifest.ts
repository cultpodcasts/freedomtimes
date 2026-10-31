/**
 * Single source for the ft-social-share plugin's sandbox grants. The plugin's
 * definePlugin() uses these; scripts/test-social-share.mts asserts the
 * astro.config.ts descriptor lists exactly the same values, so a new network
 * can't be allowed in one place and blocked in the other.
 */
import { BLUESKY_HOST } from './bluesky';

export const SOCIAL_SHARE_CAPABILITIES = ['content:read', 'network:request'] as const;
export const SOCIAL_SHARE_ALLOWED_HOSTS = [BLUESKY_HOST] as const;
