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

export type CultClassificationAudit = {
  /** Terms that matched to trigger cult classification */
  matchedTerms: string[];
  /** Where the matches were found: 'title' | 'description' | 'body' | 'dek' */
  matchLocations: string[];
  /** Context snippets around each match for verification */
  matchContexts: string[];
  /** Which pipeline stage performed the classification */
  classificationSource: string;
  /** Which filters were checked during classification */
  filtersChecked: string[];
  /** Results of each filter check */
  filterResults: Record<string, { passed: boolean; reason?: string }>;
  /** Timestamp of classification */
  classifiedAt: string;
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
  /** Audit trail explaining why this story was classified as cult-related */
  classificationAudit?: CultClassificationAudit;
};

export type PipelineResult =
  | {
      status: 'rejected';
      source: SourceMetadata;
      relevance: RelevanceResult;
      reason: string;
      /** Present when the page was fetched and parsed (all reject stages after fetch). */
      title?: string;
      textPreview?: string;
    }
  | {
      status: 'drafted';
      source: SourceMetadata;
      relevance: RelevanceResult;
      draft: DraftPayload;
    };
