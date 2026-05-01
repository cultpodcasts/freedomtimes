export type AgentEnv = 'staging';

export type RunInput = {
  url: string;
};

export type SourceMetadata = {
  url: string;
  publisher: string;
  host: string;
  retrievedAt: string;
  publishedAt?: string;
  reliabilityScore: number;
  reliabilityReasons: string[];
};

export type RelevanceResult = {
  accepted: boolean;
  region: 'UK' | 'Europe' | 'Unknown';
  confidence: number;
  reasons: string[];
};

export type DraftPayload = {
  title: string;
  dek: string;
  body: string;
  tags: string[];
  region: 'UK' | 'Europe';
  confidence: number;
  reviewNotes: string;
  source: SourceMetadata;
};

export type PipelineResult =
  | {
      status: 'rejected';
      source: SourceMetadata;
      relevance: RelevanceResult;
      reason: string;
    }
  | {
      status: 'drafted';
      source: SourceMetadata;
      relevance: RelevanceResult;
      draft: DraftPayload;
    };
