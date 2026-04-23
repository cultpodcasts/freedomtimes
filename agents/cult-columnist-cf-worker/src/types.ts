import type { AgentNamespace } from 'agents';
import type { CultAgentOrchestrator } from './orchestrator';

export type Env = {
  AGENT_DB: D1Database;
  AGENT_STORE: R2Bucket;
  CANDIDATE_FETCH_QUEUE: Queue<CandidateFetchQueueMessage>;
  RUN_PROGRESS_HUB: DurableObjectNamespace;
  ORCHESTRATOR: AgentNamespace<CultAgentOrchestrator>;
  AUTH0_DOMAIN: string;
  AUTH0_API_AUDIENCE: string;
  AUTH0_ROLES_CLAIM_NAMESPACE?: string;
  AUTH0_CLIENT_ID?: string;
  AUTH0_CLIENT_SECRET?: string;
  NEWSDATA_ENABLED?: string;
  NEWSDATA_API_KEY?: string;
  NEWSIO_API_KEY?: string;
  NEWSDATA_COUNTRY_CODES?: string;
  NEWSDATA_LANGUAGES?: string;
  NEWSDATA_QUERY_LIMIT?: string;
  NEWSDATA_TIMEFRAME_HOURS?: string;
  /** Must be explicitly set to 'true' alongside AUTH0_DOMAIN=test.auth0.com to enable test token bypass. Never set in staging/production. */
  ALLOW_TEST_TOKENS?: string;
};

export type RunStatus =
  | 'started'
  | 'awaiting_review_feed_fetch'
  | 'awaiting_review_candidate_extract'
  | 'failed'
  | 'no_stories'
  | 'published_draft';

export type FeedRow = {
  id: string;
  title: string;
  url: string;
  source_format: string;
  source_category: string;
  language: string;
  requires_url_resolution: number;
  enabled: number;
};

export type CandidateInsert = {
  runId: string;
  feedId: string;
  sourceLanguage: string;
  rawUrl: string;
  title: string | null;
  pubDate: string | null;
  requiresUrlResolution: number;
};

export type StageName = 'feed_fetch' | 'candidate_extract';

export type CandidateFetchQueueMessage = {
  runId: string;
  candidateId: number;
  rawUrl: string;
  requiresUrlResolution: number;
};
