import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadClusterLayout,
  mergeUrlsIntoCluster,
  saveClusterLayout,
  type ClusterLayout,
} from './clusterLayout.ts';
import type { ReviewReportPayload, ReviewReportStory } from './reviewReport.ts';
import { loadReviewReportLatest, writeReviewReport } from './reviewReport.ts';

export const ARTICLE_PLAN_PATH = fileURLToPath(
  new URL('../data/feedback/article-plan.json', import.meta.url),
);
export const ARTICLE_PLAN_FINALIZED_PATH = fileURLToPath(
  new URL('../reports/article-plan.json', import.meta.url),
);

export type ArticlePlanUnitKind = 'cluster' | 'story';

export type ArticlePlanUnit = {
  id: string;
  kind: ArticlePlanUnitKind;
  clusterId: string | null;
  clusterType: 'detected' | 'independent';
  label: string;
  storyCount: number;
  urls: string[];
  titles: string[];
  hosts: string[];
  topProperNouns: string[];
};

export type ArticlePlanArticleType = 'standalone' | 'roundup' | 'skip';

export type ArticlePlanArticle = {
  id: string;
  type: ArticlePlanArticleType;
  title: string;
  unitIds: string[];
  notes?: string;
};

export type ArticlePlanState = {
  reviewReportId: string;
  reviewReportGeneratedAt: string;
  visibleStoryCount: number;
  updatedAt: string;
  status: 'draft' | 'finalized';
  units: ArticlePlanUnit[];
  articles: ArticlePlanArticle[];
  /** unitId → articleId; null key omitted when unassigned */
  assignments: Record<string, string>;
};

export type FinalizedArticlePlanStory = ReviewReportStory & {
  unitId: string;
  unitLabel: string;
};

export type FinalizedArticlePlanEntry = {
  id: string;
  type: ArticlePlanArticleType;
  title: string;
  notes?: string;
  unitIds: string[];
  stories: FinalizedArticlePlanStory[];
};

export type FinalizedArticlePlan = {
  reviewReportId: string;
  reviewReportGeneratedAt: string;
  finalizedAt: string;
  articleCount: number;
  skippedCount: number;
  articles: FinalizedArticlePlanEntry[];
};

const DEFAULT_ROUNDUP_ID = 'roundup-weekly';
const SKIP_BUCKET_ID = 'bucket-skip';

function unitIdForCluster(clusterId: string | undefined, label: string): string {
  const key = (clusterId || label).replace(/\s+/g, '-').toLowerCase();
  return `cluster:${key}`;
}

function unitIdForStory(url: string): string {
  return `story:${encodeURIComponent(url)}`;
}

function topProperNouns(stories: ReviewReportStory[], limit = 6): string[] {
  const counts = new Map<string, number>();
  for (const story of stories) {
    for (const noun of story.signals.properNouns ?? []) {
      const key = noun.trim();
      if (key.length < 3) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([noun]) => noun);
}

export function buildArticlePlanUnits(report: ReviewReportPayload): ArticlePlanUnit[] {
  const units: ArticlePlanUnit[] = [];

  for (const cluster of report.clusters) {
    if (cluster.type === 'detected') {
      const stories = cluster.stories;
      units.push({
        id: unitIdForCluster(cluster.id, cluster.label),
        kind: 'cluster',
        clusterId: cluster.id ?? null,
        clusterType: 'detected',
        label: cluster.label,
        storyCount: stories.length,
        urls: stories.map((s) => s.url),
        titles: stories.map((s) => s.title),
        hosts: [...new Set(stories.map((s) => s.host).filter(Boolean) as string[])],
        topProperNouns: topProperNouns(stories),
      });
      continue;
    }

    for (const story of cluster.stories) {
      units.push({
        id: unitIdForStory(story.url),
        kind: 'story',
        clusterId: cluster.id ?? null,
        clusterType: 'independent',
        label: story.title,
        storyCount: 1,
        urls: [story.url],
        titles: [story.title],
        hosts: story.host ? [story.host] : [],
        topProperNouns: topProperNouns([story], 4),
      });
    }
  }

  return units;
}

function defaultArticles(): ArticlePlanArticle[] {
  return [
    {
      id: DEFAULT_ROUNDUP_ID,
      type: 'roundup',
      title: 'Weekly roundup',
      unitIds: [],
    },
    {
      id: SKIP_BUCKET_ID,
      type: 'skip',
      title: 'Skip for now',
      unitIds: [],
    },
  ];
}

function syncArticleUnitIds(articles: ArticlePlanArticle[], assignments: Record<string, string>): void {
  for (const article of articles) {
    article.unitIds = [];
  }
  for (const [unitId, articleId] of Object.entries(assignments)) {
    const article = articles.find((a) => a.id === articleId);
    if (article && !article.unitIds.includes(unitId)) {
      article.unitIds.push(unitId);
    }
  }
}

function mergeSavedPlan(
  report: ReviewReportPayload,
  units: ArticlePlanUnit[],
  saved: ArticlePlanState | null,
): ArticlePlanState {
  const unitIds = new Set(units.map((u) => u.id));
  let articles = saved?.reviewReportId === report.reportId ? [...saved.articles] : defaultArticles();
  let assignments: Record<string, string> = {};

  if (saved?.reviewReportId === report.reportId) {
    assignments = Object.fromEntries(
      Object.entries(saved.assignments).filter(([unitId, articleId]) => unitIds.has(unitId)),
    );
  }

  const articleIds = new Set(articles.map((a) => a.id));
  if (!articleIds.has(DEFAULT_ROUNDUP_ID)) {
    articles.unshift({
      id: DEFAULT_ROUNDUP_ID,
      type: 'roundup',
      title: 'Weekly roundup',
      unitIds: [],
    });
  }
  if (!articleIds.has(SKIP_BUCKET_ID)) {
    articles.push({
      id: SKIP_BUCKET_ID,
      type: 'skip',
      title: 'Skip for now',
      unitIds: [],
    });
  }

  const assignedStandaloneIds = new Set(
    Object.values(assignments).filter((id) => id.startsWith('standalone-')),
  );
  articles = articles.filter(
    (a) => a.type !== 'standalone' || a.unitIds.length > 0 || assignedStandaloneIds.has(a.id),
  );

  syncArticleUnitIds(articles, assignments);

  return {
    reviewReportId: report.reportId,
    reviewReportGeneratedAt: report.generatedAt,
    visibleStoryCount: report.visibleStoryCount,
    updatedAt: new Date().toISOString(),
    status: saved?.reviewReportId === report.reportId ? saved.status : 'draft',
    units,
    articles,
    assignments,
  };
}

export function loadArticlePlanDraft(): ArticlePlanState | null {
  if (!existsSync(ARTICLE_PLAN_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(ARTICLE_PLAN_PATH, 'utf-8')) as ArticlePlanState;
  } catch {
    return null;
  }
}

export function saveArticlePlanDraft(plan: ArticlePlanState): void {
  mkdirSync(new URL('../data/feedback/', import.meta.url), { recursive: true });
  plan.updatedAt = new Date().toISOString();
  syncArticleUnitIds(plan.articles, plan.assignments);
  writeFileSync(ARTICLE_PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
}

export function buildArticlePlanState(report?: ReviewReportPayload | null): ArticlePlanState {
  const reviewReport = report ?? loadReviewReportLatest();
  if (!reviewReport) {
    throw new Error('No review report found. Finalize digest review or run: npm run build:review-report');
  }
  const units = buildArticlePlanUnits(reviewReport);
  const saved = loadArticlePlanDraft();
  return mergeSavedPlan(reviewReport, units, saved);
}

export function createStandaloneArticle(unit: ArticlePlanUnit): ArticlePlanArticle {
  return {
    id: `standalone-${unit.id}`,
    type: 'standalone',
    title: unit.label,
    unitIds: [unit.id],
  };
}

export function assignUnit(
  plan: ArticlePlanState,
  unitId: string,
  articleId: string,
): ArticlePlanState {
  const unit = plan.units.find((u) => u.id === unitId);
  const target = plan.articles.find((a) => a.id === articleId);
  if (!unit || !target) {
    throw new Error('Unknown unit or article bucket');
  }

  delete plan.assignments[unitId];
  for (const article of plan.articles) {
    article.unitIds = article.unitIds.filter((id) => id !== unitId);
  }

  if (target.type === 'standalone') {
    const existingStandalone = plan.articles.find(
      (a) => a.type === 'standalone' && a.unitIds.includes(unitId),
    );
    if (existingStandalone && existingStandalone.id !== articleId) {
      existingStandalone.unitIds = existingStandalone.unitIds.filter((id) => id !== unitId);
    }
    let standalone = plan.articles.find((a) => a.id === `standalone-${unitId}`);
    if (!standalone) {
      standalone = createStandaloneArticle(unit);
      plan.articles.push(standalone);
    }
    plan.assignments[unitId] = standalone.id;
    if (!standalone.unitIds.includes(unitId)) {
      standalone.unitIds.push(unitId);
    }
    return plan;
  }

  plan.assignments[unitId] = articleId;
  if (!target.unitIds.includes(unitId)) {
    target.unitIds.push(unitId);
  }
  return plan;
}

export function unassignUnit(plan: ArticlePlanState, unitId: string): ArticlePlanState {
  const articleId = plan.assignments[unitId];
  delete plan.assignments[unitId];
  if (articleId) {
    const article = plan.articles.find((a) => a.id === articleId);
    if (article) {
      article.unitIds = article.unitIds.filter((id) => id !== unitId);
      if (article.type === 'standalone' && article.unitIds.length === 0) {
        plan.articles = plan.articles.filter((a) => a.id !== article.id);
      }
    }
  }
  return plan;
}

export function addRoundupArticle(plan: ArticlePlanState, title?: string): ArticlePlanArticle {
  const id = `roundup-${Date.now()}`;
  const article: ArticlePlanArticle = {
    id,
    type: 'roundup',
    title: title?.trim() || 'Roundup article',
    unitIds: [],
  };
  plan.articles.push(article);
  return article;
}

export function planProgress(plan: ArticlePlanState): {
  total: number;
  assigned: number;
  unassigned: number;
  standaloneCount: number;
  roundupCount: number;
  skippedCount: number;
} {
  const assigned = Object.keys(plan.assignments).length;
  const standaloneCount = plan.articles.filter((a) => a.type === 'standalone').length;
  const roundupUnits = plan.articles
    .filter((a) => a.type === 'roundup')
    .reduce((n, a) => n + a.unitIds.length, 0);
  const skippedCount = plan.articles.find((a) => a.id === SKIP_BUCKET_ID)?.unitIds.length ?? 0;
  return {
    total: plan.units.length,
    assigned,
    unassigned: plan.units.length - assigned,
    standaloneCount,
    roundupCount: roundupUnits,
    skippedCount,
  };
}

function storyByUrl(report: ReviewReportPayload): Map<string, ReviewReportStory & { clusterLabel: string }> {
  const map = new Map<string, ReviewReportStory & { clusterLabel: string }>();
  for (const cluster of report.clusters) {
    for (const story of cluster.stories) {
      map.set(story.url, { ...story, clusterLabel: cluster.label });
    }
  }
  return map;
}

export function finalizeArticlePlan(plan: ArticlePlanState, report: ReviewReportPayload): FinalizedArticlePlan {
  const progress = planProgress(plan);
  if (progress.unassigned > 0) {
    throw new Error(`${progress.unassigned} stor${progress.unassigned === 1 ? 'y' : 'ies'} still unassigned`);
  }

  const byUrl = storyByUrl(report);
  const articles: FinalizedArticlePlanEntry[] = [];

  for (const article of plan.articles) {
    if (article.unitIds.length === 0) continue;
    const stories: FinalizedArticlePlanStory[] = [];
    for (const unitId of article.unitIds) {
      const unit = plan.units.find((u) => u.id === unitId);
      if (!unit) continue;
      for (const url of unit.urls) {
        const story = byUrl.get(url);
        if (story) {
          stories.push({
            ...story,
            unitId: unit.id,
            unitLabel: unit.label,
          });
        }
      }
    }
    if (stories.length === 0) continue;
    articles.push({
      id: article.id,
      type: article.type,
      title: article.title,
      notes: article.notes,
      unitIds: [...article.unitIds],
      stories,
    });
  }

  const finalized: FinalizedArticlePlan = {
    reviewReportId: report.reportId,
    reviewReportGeneratedAt: report.generatedAt,
    finalizedAt: new Date().toISOString(),
    articleCount: articles.filter((a) => a.type !== 'skip').length,
    skippedCount: articles.find((a) => a.type === 'skip')?.stories.length ?? 0,
    articles,
  };

  mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
  writeFileSync(ARTICLE_PLAN_FINALIZED_PATH, `${JSON.stringify(finalized, null, 2)}\n`, 'utf-8');

  plan.status = 'finalized';
  saveArticlePlanDraft(plan);

  return finalized;
}

export function loadFinalizedArticlePlan(): FinalizedArticlePlan | null {
  if (!existsSync(ARTICLE_PLAN_FINALIZED_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(ARTICLE_PLAN_FINALIZED_PATH, 'utf-8')) as FinalizedArticlePlan;
  } catch {
    return null;
  }
}

function migrateAssignmentsAfterUnitMerge(
  assignments: Record<string, string>,
  articles: ArticlePlanArticle[],
  removedUnitIds: string[],
  newUnitId: string,
): void {
  let targetArticleId: string | null = null;
  for (const unitId of removedUnitIds) {
    if (assignments[unitId]) {
      targetArticleId = assignments[unitId];
      break;
    }
  }

  for (const unitId of removedUnitIds) {
    delete assignments[unitId];
    for (const article of articles) {
      article.unitIds = article.unitIds.filter((id) => id !== unitId);
    }
  }

  for (let i = articles.length - 1; i >= 0; i -= 1) {
    const article = articles[i];
    if (!article) continue;
    if (article.type === 'standalone' && removedUnitIds.some((id) => article.id === `standalone-${id}`)) {
      articles.splice(i, 1);
    }
  }

  if (!targetArticleId) {
    return;
  }

  assignments[newUnitId] = targetArticleId;
  const article = articles.find((a) => a.id === targetArticleId);
  if (article && !article.unitIds.includes(newUnitId)) {
    article.unitIds.push(newUnitId);
  }
  if (article?.type === 'standalone') {
    article.title = article.title;
  }
}

/** Merge article-plan units, persist cluster layout, and rebuild review report. */
export async function mergeArticlePlanUnits(
  unitIds: string[],
  label: string,
): Promise<ArticlePlanState> {
  if (unitIds.length < 2) {
    throw new Error('Select at least two units to merge');
  }

  const plan = buildArticlePlanState();
  if (plan.status === 'finalized') {
    throw new Error('Article plan is finalized. Reset reports/article-plan.json to edit clusters.');
  }

  const units = unitIds.map((id) => plan.units.find((u) => u.id === id)).filter(Boolean) as ArticlePlanUnit[];
  if (units.length !== unitIds.length) {
    throw new Error('One or more units not found');
  }

  const urls = [...new Set(units.flatMap((u) => u.urls))];
  if (urls.length < 2) {
    throw new Error('Merged cluster must include at least two stories');
  }

  let layout: ClusterLayout = loadClusterLayout() ?? {
    updatedAt: new Date().toISOString(),
    clusters: [],
    independentUrls: [],
  };
  layout = mergeUrlsIntoCluster(layout, urls, label);
  saveClusterLayout(layout);

  const report = await writeReviewReport();
  const rebuilt = buildArticlePlanState(report);
  const newUnit = rebuilt.units.find(
    (u) => u.kind === 'cluster' && u.urls.length === urls.length && urls.every((url) => u.urls.includes(url)),
  );
  if (!newUnit) {
    throw new Error('Failed to build merged cluster unit');
  }

  migrateAssignmentsAfterUnitMerge(rebuilt.assignments, rebuilt.articles, unitIds, newUnit.id);
  if (newUnit.kind === 'cluster' && rebuilt.assignments[newUnit.id]) {
    const articleId = rebuilt.assignments[newUnit.id];
    const article = rebuilt.articles.find((a) => a.id === articleId);
    if (article?.type === 'standalone') {
      article.title = label.trim() || newUnit.label;
    }
  }

  saveArticlePlanDraft(rebuilt);
  return rebuilt;
}
