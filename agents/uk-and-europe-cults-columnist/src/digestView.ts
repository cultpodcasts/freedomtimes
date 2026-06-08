import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyClusterLayout,
  loadClusterLayout,
  storyUrlKey,
  type LayoutStoryGroup,
} from './clusterLayout.ts';
import type { EnrichedStory } from '../scripts/render-cult-news-html.helpers.ts';
import {
  buildCitationReport,
  type CitationReport,
  type StoryCitationInput,
} from './sourceCitation.ts';

export const CORPUS_PATH = fileURLToPath(
  new URL('../reports/digest-corpus.json', import.meta.url),
);
export const VIEW_SNAPSHOT_PATH = fileURLToPath(
  new URL('../reports/digest-view-snapshot.json', import.meta.url),
);

export type DigestCorpus = {
  generatedAt: string;
  renderMaxAgeHours: number | null;
  draftSource: string;
  draftCount: number;
  storyCount: number;
  stories: EnrichedStory[];
};

export type DigestViewGroup = LayoutStoryGroup<EnrichedStory>;

export type DigestViewSnapshot = {
  corpusGeneratedAt: string;
  generatedAt: string;
  autoGroups: DigestViewGroup[];
  citedStoryCount: number;
};

export type DigestViewPayload = {
  generatedAt: string;
  corpusGeneratedAt: string;
  totalCount: number;
  visibleStoryCount: number;
  corpusStoryCount: number;
  groups: DigestViewGroup[];
  citationReport: CitationReport;
};

type FeedbackFile = {
  entries?: Array<{ url?: string; reason?: string }>;
};

function loadFeedbackEntries(): FeedbackFile['entries'] {
  const feedbackPath = new URL('../data/feedback/false-positives.json', import.meta.url);
  if (!existsSync(feedbackPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(feedbackPath, 'utf-8')) as FeedbackFile;
    return parsed.entries ?? [];
  } catch {
    return [];
  }
}

export function loadPersistedFalsePositiveUrlKeys(): Set<string> {
  const entries = loadFeedbackEntries() ?? [];
  return new Set(
    entries
      .filter((entry) => entry.reason === 'false-positive' && typeof entry.url === 'string')
      .map((entry) => storyUrlKey(entry.url!)),
  );
}

export function loadWrongClusterUrlKeys(): Set<string> {
  const entries = loadFeedbackEntries() ?? [];
  return new Set(
    entries
      .filter((entry) => entry.reason === 'wrong-cluster' && typeof entry.url === 'string')
      .map((entry) => storyUrlKey(entry.url!)),
  );
}

export function loadDigestCorpus(): DigestCorpus | null {
  if (!existsSync(CORPUS_PATH)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8')) as DigestCorpus;
    if (!parsed || !Array.isArray(parsed.stories)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function loadDigestViewSnapshot(): DigestViewSnapshot | null {
  if (!existsSync(VIEW_SNAPSHOT_PATH)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(VIEW_SNAPSHOT_PATH, 'utf-8')) as DigestViewSnapshot;
    if (!parsed || !Array.isArray(parsed.autoGroups)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function filterStoriesExcludingFalsePositives(
  stories: EnrichedStory[],
  blocklist: Set<string>,
): EnrichedStory[] {
  return stories.filter((story) => !blocklist.has(storyUrlKey(story.url)));
}

function storyCitationInput(story: EnrichedStory): StoryCitationInput {
  return {
    title: story.title,
    url: story.url,
    host: story.host,
    publishedAt: story.publishedAt,
    articleText: story.articleText,
    contentMirrorUrl: story.contentMirrorUrl,
    archiveMirrorLinks: story.archiveMirrorLinks,
  };
}

function filterGroupsByFalsePositives(
  groups: DigestViewGroup[],
  blocklist: Set<string>,
): DigestViewGroup[] {
  const detached: EnrichedStory[] = [];
  const result: DigestViewGroup[] = [];

  for (const group of groups) {
    const remaining = group.stories.filter((story) => !blocklist.has(storyUrlKey(story.url)));
    if (remaining.length === 0) {
      continue;
    }
    if (group.type === 'independent') {
      result.push({ ...group, stories: remaining });
      continue;
    }
    if (remaining.length >= 2) {
      result.push({ ...group, stories: remaining });
    } else {
      detached.push(...remaining);
    }
  }

  if (detached.length > 0) {
    const independent = result.find((group) => group.type === 'independent');
    if (independent) {
      independent.stories.push(...detached);
    } else {
      result.push({
        label: 'Independent Journalism',
        type: 'independent',
        stories: detached,
      });
    }
  }

  return result;
}

function applyWrongClusterDetachment(
  groups: DigestViewGroup[],
  wrongClusterKeys: Set<string>,
): DigestViewGroup[] {
  if (wrongClusterKeys.size === 0) {
    return groups;
  }

  const detached: EnrichedStory[] = [];
  const result: DigestViewGroup[] = [];

  for (const group of groups) {
    if (group.type === 'independent') {
      const remaining = group.stories.filter((story) => !wrongClusterKeys.has(storyUrlKey(story.url)));
      result.push({ ...group, stories: remaining });
      continue;
    }

    const remaining = group.stories.filter((story) => !wrongClusterKeys.has(storyUrlKey(story.url)));
    detached.push(...group.stories.filter((story) => wrongClusterKeys.has(storyUrlKey(story.url))));

    if (remaining.length >= 2) {
      result.push({ ...group, stories: remaining });
    } else {
      detached.push(...remaining);
    }
  }

  if (detached.length > 0) {
    const independent = result.find((group) => group.type === 'independent');
    if (independent) {
      const seen = new Set(independent.stories.map((story) => storyUrlKey(story.url)));
      for (const story of detached) {
        const key = storyUrlKey(story.url);
        if (!seen.has(key)) {
          seen.add(key);
          independent.stories.push(story);
        }
      }
    } else {
      result.push({
        label: 'Independent Journalism',
        type: 'independent',
        stories: detached,
      });
    }
  }

  return result;
}

function collectStoriesFromGroups(groups: DigestViewGroup[]): EnrichedStory[] {
  const seen = new Set<string>();
  const stories: EnrichedStory[] = [];
  for (const group of groups) {
    for (const story of group.stories) {
      const key = storyUrlKey(story.url);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      stories.push(story);
    }
  }
  return stories;
}

function buildPayloadFromGroups(
  groups: DigestViewGroup[],
  corpus: DigestCorpus,
): DigestViewPayload {
  const visibleStories = collectStoriesFromGroups(groups);
  const generatedAt = new Date().toISOString();
  const citationReport = buildCitationReport(
    groups.map((group) => ({
      label: group.label,
      type: group.type,
      stories: group.stories.map(storyCitationInput),
    })),
    generatedAt,
  );

  return {
    generatedAt,
    corpusGeneratedAt: corpus.generatedAt,
    totalCount: visibleStories.length,
    visibleStoryCount: visibleStories.length,
    corpusStoryCount: corpus.storyCount,
    groups,
    citationReport,
  };
}

function buildDigestViewFromSnapshot(
  corpus: DigestCorpus,
  snapshot: DigestViewSnapshot,
  options?: { excludePersistedFalsePositives?: boolean },
): DigestViewPayload {
  const exclude = options?.excludePersistedFalsePositives ?? true;
  let groups = snapshot.autoGroups.map((group) => ({
    ...group,
    stories: [...group.stories],
  }));

  if (exclude) {
    groups = filterGroupsByFalsePositives(groups, loadPersistedFalsePositiveUrlKeys());
  }

  groups = applyWrongClusterDetachment(groups, loadWrongClusterUrlKeys());

  const visibleStories = collectStoriesFromGroups(groups);
  const layout = loadClusterLayout();
  const layoutedGroups = applyClusterLayout(groups, visibleStories, layout) as DigestViewGroup[];

  return buildPayloadFromGroups(layoutedGroups, corpus);
}

/** Build grouped digest view from corpus + feedback files (no HTTP re-fetch). */
export async function buildDigestView(options?: {
  excludePersistedFalsePositives?: boolean;
}): Promise<DigestViewPayload> {
  const corpus = loadDigestCorpus();
  if (!corpus) {
    throw new Error('Digest corpus not found. Run: npm run render:html');
  }

  const snapshot = loadDigestViewSnapshot();
  if (snapshot && snapshot.corpusGeneratedAt === corpus.generatedAt) {
    return buildDigestViewFromSnapshot(corpus, snapshot, options);
  }

  const exclude = options?.excludePersistedFalsePositives ?? true;
  let visibleStories = corpus.stories;
  if (exclude) {
    visibleStories = filterStoriesExcludingFalsePositives(
      corpus.stories,
      loadPersistedFalsePositiveUrlKeys(),
    );
  }

  const renderModule = await import('../scripts/render-cult-news-html.tsx');
  const built = renderModule.buildDigestViewFromStories(
    visibleStories,
    loadWrongClusterUrlKeys(),
  );

  return {
    generatedAt: built.generatedAt,
    corpusGeneratedAt: corpus.generatedAt,
    totalCount: built.totalCount,
    visibleStoryCount: visibleStories.length,
    corpusStoryCount: corpus.storyCount,
    groups: built.groups,
    citationReport: built.citationReport,
  };
}
