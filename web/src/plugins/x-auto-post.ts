/**
 * On publish, post the article to X and Bluesky when that network's secrets
 * are set. Otherwise the post editor's intent link is the fallback. Staging
 * and local always dry-run. Nothing is emailed. See web/docs/X_AUTO_POST.md.
 *
 * The admin panels are a different plugin and use the same clients and KV keys.
 */
import { env as cfEnv } from 'cloudflare:workers';
import type { ResolvedPlugin } from 'emdash';
import { definePlugin } from 'emdash';

import { X_AUTO_ALLOWED_HOSTS, X_AUTO_CAPABILITIES } from '../lib/x-auto/manifest';
import { handleXAutoPublish } from '../lib/x-auto/run';

export const X_AUTO_PLUGIN_ID = 'ft-x-auto-post';

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: X_AUTO_PLUGIN_ID,
		version: '1.0.0',
		capabilities: [...X_AUTO_CAPABILITIES],
		allowedHosts: [...X_AUTO_ALLOWED_HOSTS],
		hooks: {
			'content:afterPublish': {
				timeout: 20_000,
				errorPolicy: 'continue',
				handler: async (event, ctx) => {
					await handleXAutoPublish(event.content, event.collection, {
						env: cfEnv as unknown as Record<string, unknown>,
						kv: ctx.kv,
						now: () => new Date(),
						fetch: async (url, init) => {
							if (!ctx.http) throw new Error('Network access is not available to this plugin.');
							return ctx.http.fetch(url, init);
						},
						log: (level, message) => {
							ctx.log[level](message);
						},
					});
				},
			},
		},
	});
}

export default createPlugin;
