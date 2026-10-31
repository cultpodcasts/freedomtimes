/**
 * Site-local EmDash plugin: admin-only "Post to Bluesky" panel on the post
 * editor (#21). See web/docs/SOCIAL_SHARING.md.
 *
 * Admin-only by construction:
 * - The panel exists only in the EmDash admin post editor (Block Kit editor
 *   panel). No public page, layout or script renders it or links its route.
 * - Its route is private with the default `plugins:manage` permission
 *   (EmDash Admin role): EmDash rejects anonymous callers (401), non-admins
 *   (403) and cookie requests without the `X-EmDash-Request: 1` CSRF header
 *   before the handler runs. The handler re-checks the Admin role and that it
 *   was dispatched from the editor panel for a saved post.
 * - Production only: on staging/local it shows a "disabled" note and has no
 *   button. Missing secrets show "not configured", never an error.
 * Nothing is posted until an admin presses the button and confirms.
 */
import { env as cfEnv } from 'cloudflare:workers';
import type { ResolvedPlugin } from 'emdash';
import { definePlugin, PluginRouteError } from 'emdash';

import { blueskyProvider } from '../lib/social-share/bluesky';
import { SOCIAL_SHARE_ALLOWED_HOSTS, SOCIAL_SHARE_CAPABILITIES } from '../lib/social-share/manifest';
import { handleSharePanel, ShareAccessError, type ShareKv } from '../lib/social-share/panel';
import { snapshotFromContentItem } from '../lib/social-share/policy';

export const SOCIAL_SHARE_PLUGIN_ID = 'ft-social-share';

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: SOCIAL_SHARE_PLUGIN_ID,
		version: '1.0.0',
		capabilities: [...SOCIAL_SHARE_CAPABILITIES],
		allowedHosts: [...SOCIAL_SHARE_ALLOWED_HOSTS],
		routes: {
			// Private (no `public`), default permission plugins:manage = Admin.
			'editor/bluesky': {
				handler: async (ctx) => {
					try {
						return await handleSharePanel(
							{ input: ctx.input, ui: ctx.ui, user: ctx.user, requestUrl: ctx.request.url },
							{
								provider: blueskyProvider,
								env: cfEnv as unknown as Record<string, unknown>,
								kv: ctx.kv as unknown as ShareKv,
								getPost: async (id) => {
									const item = await ctx.content?.get('posts', id);
									return item ? snapshotFromContentItem(item) : null;
								},
								fetch: async (url, init) => {
									if (!ctx.http) throw new Error('Network access is not available to this plugin.');
									return ctx.http.fetch(url, init);
								},
								now: () => new Date(),
							},
						);
					} catch (error) {
						if (error instanceof ShareAccessError) {
							throw new PluginRouteError(error.code, error.message, error.status);
						}
						throw error;
					}
				},
			},
		},
		admin: {
			editorPanels: [{ id: 'bluesky', title: 'Post to Bluesky', route: 'editor/bluesky', collections: ['posts'] }],
		},
	});
}

export default createPlugin;
