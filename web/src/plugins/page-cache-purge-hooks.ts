/**
 * Hook handlers for the `ft-page-cache-purge` plugin, with injected
 * dependencies (no `cloudflare:workers` import) so
 * scripts/test-page-cache-handler.mts can test them directly.
 *
 * Scheduled publishes go through EmDash `handleContentPublish`, which runs
 * `content:afterPublish`, so they purge too.
 */
export type PurgeHookDeps = {
  /** True when the reader cache is on (production); staging is a no-op. */
  isEnabled: () => boolean;
  bump: (reason: string) => Promise<void>;
};

type ContentEvent = { collection?: string; content?: { status?: unknown } | null };

export function createPurgeHooks(deps: PurgeHookDeps) {
  const purge = async (reason: string): Promise<void> => {
    if (!deps.isEnabled()) return;
    await deps.bump(reason);
  };
  return {
    afterSave: async (event: ContentEvent): Promise<void> => {
      // Draft saves of an unpublished entry change nothing public.
      if (event.content?.status !== 'published') return;
      await purge(`afterSave:${event.collection}`);
    },
    afterPublish: (event: ContentEvent) => purge(`afterPublish:${event.collection}`),
    afterUnpublish: (event: ContentEvent) => purge(`afterUnpublish:${event.collection}`),
    afterDelete: (event: ContentEvent) => purge(`afterDelete:${event.collection}`),
    afterRestore: (event: ContentEvent) => purge(`afterRestore:${event.collection}`),
  };
}
