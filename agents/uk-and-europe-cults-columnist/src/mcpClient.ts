import type { DraftPayload } from './types.js';

export async function createDraftViaMcp(draft: DraftPayload): Promise<{ draftId: string }> {
  void draft;

  // Placeholder for MCP CMS integration.
  // Keep this as a dedicated boundary so transport/auth can be swapped without
  // changing ingestion/relevance logic.
  throw new Error('MCP integration is not implemented yet. Run in DRY_RUN=true mode.');
}
