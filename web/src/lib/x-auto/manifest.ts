/**
 * Sandbox grants for the ft-x-auto-post plugin. definePlugin() uses these;
 * scripts/test-x-auto-post.mts asserts astro.config.ts lists the same values.
 */
export const X_AUTO_CAPABILITIES = ['content:read', 'network:request'] as const;
export const X_AUTO_ALLOWED_HOSTS = ['api.x.com', 'bsky.social'] as const;
