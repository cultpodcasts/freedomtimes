/**
 * Stage Output Contracts
 *
 * These types define the canonical output shape for each pipeline stage.
 * Both the Node.js agent and the CF worker must produce data conforming to
 * these contracts. Use them in contract tests to catch divergences.
 *
 * HOW TO USE:
 *   - CF worker: each stage writes rows to D1; dump via GET /debug/stage-output
 *     (local only, available in wrangler dev --env local)
 *   - Node.js agent: log output matches these shapes via [agent][progress] lines
 *
 * Add a new contract for each stage as it is ported to the CF worker.
 */

// ---------------------------------------------------------------------------
// Stage 1: Feed Fetch
// Node.js equivalent: discoverStories.ts#parseFeed per feed URL
// CF equivalent:      stages/feedFetch.ts → http_cache_entries table
// ---------------------------------------------------------------------------

export type FeedFetchItem = {
  /** The feed URL that was fetched */
  requestUrl: string;
  /** HTTP status code returned */
  status: number;
  /** Whether the fetch was considered successful (2xx) */
  ok: boolean;
  /** ISO timestamp of when the fetch occurred */
  fetchedAt: string;
};

export type FeedFetchStageOutput = {
  stage: 'feed_fetch';
  fetched: number;
  failed: number;
  items: FeedFetchItem[];
};

// ---------------------------------------------------------------------------
// Stage 2: Candidate Extract
// Node.js equivalent: discoverStories.ts#parseFeed + URL dedup + freshness filter
// CF equivalent:      stages/candidateExtract.ts → candidates table
// ---------------------------------------------------------------------------

export type CandidateItem = {
  /** The article URL (may be a Google News redirect that needs resolution) */
  rawUrl: string;
  /** Feed the item came from */
  feedId: string;
  /** BCP-47 language tag from the feed definition */
  sourceLanguage: string;
  /** Article title from the feed */
  title: string | null;
  /** Publication date from the feed (ISO 8601) */
  pubDate: string | null;
  /** Whether the URL must be resolved (e.g. Google News redirect) */
  requiresUrlResolution: boolean;
};

export type CandidateExtractStageOutput = {
  stage: 'candidate_extract';
  inserted: number;
  candidates: CandidateItem[];
};

// ---------------------------------------------------------------------------
// Stage 3: Pipeline (NOT YET PORTED to CF worker)
// Node.js equivalent: pipeline.ts#runPipeline per candidate
// CF equivalent:      TBD
// ---------------------------------------------------------------------------

export type PipelineDecision = 'accepted' | 'rejected' | 'errored';

export type PipelineItem = {
  url: string;
  title: string | null;
  decision: PipelineDecision;
  rejectReason?: string;
  /** Whether a CMS draft was created */
  drafted: boolean;
};

export type PipelineStageOutput = {
  stage: 'pipeline';
  accepted: number;
  rejected: number;
  errored: number;
  drafted: number;
  items: PipelineItem[];
};
