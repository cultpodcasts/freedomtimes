/**
 * Site-local EmDash plugin: admin-only "Post to Bluesky" (#21) and "Post to X"
 * (#20) panels on the post editor. See web/docs/SOCIAL_SHARING.md.
 *
 * Admin-only by construction:
 * - The panels exist only in the EmDash admin post editor (Block Kit editor
 *   panels). No public page, layout or script renders them or links their routes.
 * - Their routes are private with the default `plugins:manage` permission
 *   (EmDash Admin role): EmDash rejects anonymous callers (401), non-admins
 *   (403) and cookie requests without the `X-EmDash-Request: 1` CSRF header
 *   before the handler runs. The handler re-checks the Admin role and that it
 *   was dispatched from the editor panel for a saved post.
 * - Real accounts from production only. Staging posts only to the test
 *   accounts set in its staging-only `*_TEST_*` secrets, or dry-runs without
 *   them; local dev and other hosts always dry-run (#178). Missing production
 *   secrets show "not configured", never an error.
 * Nothing is posted until an admin presses the button and confirms.
 */
import { env as cfEnv } from 'cloudflare:workers';
import type { ResolvedPlugin, RouteContext } from 'emdash';
import { definePlugin, PluginRouteError } from 'emdash';

import { blueskyProvider } from '../lib/social-share/bluesky';
import { SOCIAL_SHARE_ALLOWED_HOSTS, SOCIAL_SHARE_CAPABILITIES } from '../lib/social-share/manifest';
import { handleSharePanel, ShareAccessError, type ShareDraftBase, type ShareKv, type ShareProvider } from '../lib/social-share/panel';
import { snapshotFromContentItem } from '../lib/social-share/policy';
import { xProvider } from '../lib/social-share/x';

export const SOCIAL_SHARE_PLUGIN_ID = 'ft-social-share';

/** One private editor-panel route per network; the logic lives in lib/social-share/panel.ts. */
function sharePanelRoute<TConfig, TDraft extends ShareDraftBase>(provider: ShareProvider<TConfig, TDraft>) {
	return {
		handler: async (ctx: RouteContext) => {
			try {
				return await handleSharePanel(
					{ input: ctx.input, ui: ctx.ui, user: ctx.user, requestUrl: ctx.request.url },
					{
						provider,
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
	};
}

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: SOCIAL_SHARE_PLUGIN_ID,
		version: '1.0.0',
		capabilities: [...SOCIAL_SHARE_CAPABILITIES],
		allowedHosts: [...SOCIAL_SHARE_ALLOWED_HOSTS],
		routes: {
			// Private (no `public`), default permission plugins:manage = Admin.
			'editor/bluesky': sharePanelRoute(blueskyProvider),
			'editor/x': sharePanelRoute(xProvider),
		},
		admin: {
			editorPanels: [
				{ id: 'bluesky', title: 'Post to Bluesky', route: 'editor/bluesky', collections: ['posts'] },
				{ id: 'x', title: 'Post to X', route: 'editor/x', collections: ['posts'] },
			],
		},
	});
}

export default createPlugin;
