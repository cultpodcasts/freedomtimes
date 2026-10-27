/**
 * Site-local EmDash plugin: purge the anonymous reader page cache when
 * published content changes (see src/lib/page-cache.ts).
 *
 * Registered in astro.config.ts as a native plugin descriptor whose
 * entrypoint is this file. Every hook just bumps the KV epoch, which orphans
 * all cached pages in every colo (homepage, archives and the post itself all
 * depend on any post). No-op when the cache is disabled (staging).
 */
import { env as cfEnv } from 'cloudflare:workers';
import type { ResolvedPlugin } from 'emdash';
import { definePlugin } from 'emdash';

import { bumpPageCacheEpoch } from '../lib/page-cache';
import { isPageCacheEnabled, type PageCacheEnv } from '../lib/page-cache-policy';
import { createPurgeHooks } from './page-cache-purge-hooks';

export const PAGE_CACHE_PURGE_PLUGIN_ID = 'ft-page-cache-purge';

export function createPlugin(): ResolvedPlugin {
  const hooks = createPurgeHooks({
    isEnabled: () => isPageCacheEnabled(cfEnv as unknown as PageCacheEnv),
    bump: bumpPageCacheEpoch,
  });
  return definePlugin({
    id: PAGE_CACHE_PURGE_PLUGIN_ID,
    version: '1.0.0',
    // EmDash skips content:after* hooks without content:read.
    capabilities: ['content:read'],
    hooks: {
      'content:afterSave': { handler: async (event) => hooks.afterSave(event) },
      'content:afterPublish': { handler: async (event) => hooks.afterPublish(event) },
      'content:afterUnpublish': { handler: async (event) => hooks.afterUnpublish(event) },
      'content:afterDelete': { handler: async (event) => hooks.afterDelete(event) },
      'content:afterRestore': { handler: async (event) => hooks.afterRestore(event) },
    },
  });
}

export default createPlugin;
