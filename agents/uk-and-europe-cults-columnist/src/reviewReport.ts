import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanArticlePlainText } from './articleContent.ts';
import { loadClusterLayout } from './clusterLayout.ts';
import { buildDigestView, loadDigestCorpus, loadPersistedFalsePositiveUrlKeys } from './digestView.ts';
import {
  extractReportProperNouns,
  matchReportProperNounAliases,
} from './reportProperNouns.ts';
import type { EnrichedStory } from '../scripts/render-cult-news-html.helpers.ts';
import { fetchStoryMeta } from '../scripts/render-cult-news-html.helpers.ts';

export const REVIEW_REPORT_LATEST_PATH = fileURLToPath(
  new URL('../reports/review-report-latest.json', import.meta.url),
);

type ClassificationAuditShape = {
  matchedTerms?: string[];
  matchLocations?: string[];
  matchContexts?: string[];
  classificationSource?: string;
  filtersChecked?: string[];
  filterResults?: Record<string, { passed: boolean; reason?: string }>;
  properNouns?: string[];
  matchedAliases?: string[];
  classifiedAt?: string;
};

export type ReviewReportStorySignals = {
  matchedTerms: string[];
  matchLocations: string[];
  matchContexts: string[];
  classificationSource: string;
  filtersChecked: string[];
  filterResults: Record<string, { passed: boolean; reason?: string }>;
  properNouns: string[];
  matchedAliases: string[];
  classifiedAt?: string;
};

export type ReviewReportStory = {
  url: string;
  title: string;
  host?: string;
  publishedAt?: string;
  description: string;
  htmlLang?: string;
  articleText: string;
  contentMirrorUrl?: string;
  signals: ReviewReportStorySignals;
  sourceCitationMarkdown?: string;
};

export type ReviewReportCluster = {
  id?: string;
  label: string;
  type: 'detected' | 'independent';
  storyCount: number;
  stories: ReviewReportStory[];
};

export type ReviewReportPayload = {
  reportId: string;
  generatedAt: string;
  refetchedAt?: string;
  corpusGeneratedAt: string | null;
  archivedSessionId?: string;
  layoutSource: 'manual' | 'auto';
  layoutUpdatedAt: string | null;
  visibleStoryCount: number;
  corpusStoryCount: number;
  excludedFalsePositiveCount: number;
  clusters: ReviewReportCluster[];
  citationMarkdown: string;
};

function storySignalsFromAudit(
  audit: ClassificationAuditShape | undefined,
  title: string,
  articleText: string,
  htmlLang?: string,
): ReviewReportStorySignals {
  const lang = (htmlLang || 'en').split('-')[0] || 'en';
  const sourceText = `${title} ${articleText}`;
  const properNouns = extractReportProperNouns(sourceText, lang);
  const matchedAliases = matchReportProperNounAliases(properNouns);
  return {
    matchedTerms: audit?.matchedTerms ?? [],
    matchLocations: audit?.matchLocations ?? [],
    matchContexts: audit?.matchContexts ?? [],
    classificationSource: audit?.classificationSource ?? 'unknown',
    filtersChecked: audit?.filtersChecked ?? [],
    filterResults: audit?.filterResults ?? {},
    properNouns,
    matchedAliases,
    classifiedAt: audit?.classifiedAt,
  };
}

function mapStory(story: EnrichedStory): ReviewReportStory {
  const audit = story.classificationAudit as ClassificationAuditShape | undefined;
  const title = story.title;
  const articleText = story.articleText ?? '';
  return {
    url: story.url,
    title,
    host: story.host,
    publishedAt: story.publishedAt,
    description: story.description ?? '',
    htmlLang: story.htmlLang,
    articleText,
    contentMirrorUrl: story.contentMirrorUrl,
    signals: storySignalsFromAudit(audit, title, articleText, story.htmlLang),
    sourceCitationMarkdown: story.sourceCitation?.markdown,
  };
}

export async function buildReviewReport(options?: {
  reportId?: string;
  archivedSessionId?: string;
}): Promise<ReviewReportPayload> {
  const view = await buildDigestView({ excludePersistedFalsePositives: true });
  const corpus = loadDigestCorpus();
  const layout = loadClusterLayout();

  const clusters: ReviewReportCluster[] = view.groups.map((group) => ({
    id: group.id,
    label: group.label,
    type: group.type,
    storyCount: group.stories.length,
    stories: group.stories.map(mapStory),
  }));

  return {
    reportId: options?.reportId ?? new Date().toISOString().replace(/[:.]/g, '-'),
    generatedAt: new Date().toISOString(),
    corpusGeneratedAt: corpus?.generatedAt ?? null,
    archivedSessionId: options?.archivedSessionId,
    layoutSource: layout ? 'manual' : 'auto',
    layoutUpdatedAt: layout?.updatedAt ?? null,
    visibleStoryCount: view.visibleStoryCount,
    corpusStoryCount: view.corpusStoryCount,
    excludedFalsePositiveCount: loadPersistedFalsePositiveUrlKeys().size,
    clusters,
    citationMarkdown: view.citationReport.markdown,
  };
}

export function reviewReportPathForId(reportId: string): string {
  return fileURLToPath(new URL(`../reports/review-report-${reportId}.json`, import.meta.url));
}

export async function writeReviewReport(options?: {
  reportId?: string;
  archivedSessionId?: string;
}): Promise<ReviewReportPayload> {
  const report = await buildReviewReport(options);
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(REVIEW_REPORT_LATEST_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  writeFileSync(reviewReportPathForId(report.reportId), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return report;
}

export function loadReviewReportLatest(): ReviewReportPayload | null {
  if (!existsSync(REVIEW_REPORT_LATEST_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(REVIEW_REPORT_LATEST_PATH, 'utf-8')) as ReviewReportPayload;
  } catch {
    return null;
  }
}

export function saveReviewReport(report: ReviewReportPayload): void {
  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(REVIEW_REPORT_LATEST_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  writeFileSync(reviewReportPathForId(report.reportId), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
}

function refreshStorySignals(story: ReviewReportStory): void {
  const lang = (story.htmlLang || 'en').split('-')[0] || 'en';
  const sourceText = `${story.title} ${story.articleText}`;
  story.signals.properNouns = extractReportProperNouns(sourceText, lang);
  story.signals.matchedAliases = matchReportProperNounAliases(story.signals.properNouns);
}

async function refetchReviewReportStory(story: ReviewReportStory): Promise<void> {
  const meta = await fetchStoryMeta(story.url, { contentMirrorUrl: story.contentMirrorUrl });
  if (meta.title?.trim()) {
    story.title = meta.title.trim();
  }
  if (meta.description?.trim()) {
    story.description = meta.description.trim();
  }
  if (meta.articleText?.trim()) {
    story.articleText = cleanArticlePlainText(meta.articleText);
  }
  if (meta.publishedAt) {
    story.publishedAt = meta.publishedAt;
  }
  if (meta.htmlLang) {
    story.htmlLang = meta.htmlLang;
  }
  if (meta.contentMirrorUrl) {
    story.contentMirrorUrl = meta.contentMirrorUrl;
  }
  refreshStorySignals(story);
}

/** Re-fetch article text for all stories in the latest review report. */
export async function refetchReviewReport(options?: {
  onProgress?: (index: number, total: number, story: ReviewReportStory) => void;
  onStoryError?: (story: ReviewReportStory, error: unknown) => void;
}): Promise<ReviewReportPayload> {
  const report = loadReviewReportLatest();
  if (!report) {
    throw new Error('No reports/review-report-latest.json — run: npm run build:review-report');
  }

  const stories = report.clusters.flatMap((cluster) => cluster.stories);
  let index = 0;
  for (const story of stories) {
    index += 1;
    options?.onProgress?.(index, stories.length, story);
    try {
      await refetchReviewReportStory(story);
    } catch (error) {
      options?.onStoryError?.(story, error);
      refreshStorySignals(story);
    }
  }

  const updated: ReviewReportPayload = {
    ...report,
    generatedAt: new Date().toISOString(),
    refetchedAt: new Date().toISOString(),
  };
  saveReviewReport(updated);
  return updated;
}
