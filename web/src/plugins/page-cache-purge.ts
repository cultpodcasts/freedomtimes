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

export const PAGE_CACHE_PURGE_PLUGIN_ID = 'ft-page-cache-purge';

async function purge(reason: string): Promise<void> {
  if (!isPageCacheEnabled(cfEnv as unknown as PageCacheEnv)) return;
  await bumpPageCacheEpoch(reason);
}

export function createPlugin(): ResolvedPlugin {
  return definePlugin({
    id: PAGE_CACHE_PURGE_PLUGIN_ID,
    version: '1.0.0',
    // EmDash skips content:after* hooks without content:read.
    capabilities: ['content:read'],
    hooks: {
      'content:afterSave': {
        handler: async (event) => {
          // Draft saves of an unpublished entry change nothing public.
          if (event.content?.status !== 'published') return;
          await purge(`afterSave:${event.collection}`);
        },
      },
      'content:afterPublish': {
        handler: async (event) => purge(`afterPublish:${event.collection}`),
      },
      'content:afterUnpublish': {
        handler: async (event) => purge(`afterUnpublish:${event.collection}`),
      },
      'content:afterDelete': {
        handler: async (event) => purge(`afterDelete:${event.collection}`),
      },
      'content:afterRestore': {
        handler: async (event) => purge(`afterRestore:${event.collection}`),
      },
    },
  });
}

export default createPlugin;
