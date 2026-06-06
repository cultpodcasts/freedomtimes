import type { EnrichedStory } from './render-cult-news-html.helpers.ts';
import type { StoryGroup } from './render-cult-news-html.tsx';

export type ExpectedCluster = {
  id: string;
  labelPattern: string;
  minSize: number;
  requiredStoryPatterns: string[];
  exclusiveStoryPatterns?: string[];
};

export type ClusterExpectations = {
  _description?: string;
  renderMaxAgeHours?: number;
  expectedClusters: ExpectedCluster[];
  mustNotShareCluster: Array<{ id: string; storyPatterns: [string, string] | string[] }>;
  mustStayIndependent: Array<{ id: string; storyPattern: string }>;
  forbiddenMegaClusters?: Array<{
    id: string;
    labelPattern: string;
    mustNotContainPatterns: string[];
  }>;
  forbiddenClusterLabels?: Array<{ id: string; labelPattern: string }>;
  forbiddenStoryTitlePatterns?: Array<{ id: string; titlePattern: string }>;
};

export type RegressionFixture = {
  generatedAt: string;
  renderMaxAgeHours: number | null;
  draftSource: string;
  draftCount: number;
  storyCount: number;
  stories: Array<{
    title: string;
    url: string;
    host?: string;
    publishedAt?: string;
    description?: string;
    articleText?: string;
  }>;
};

export function storyHaystack(story: EnrichedStory): string {
  return `${story.title} ${story.url} ${story.description} ${story.articleText}`.toLowerCase();
}

export function matchesPattern(story: EnrichedStory, pattern: string): boolean {
  return storyHaystack(story).includes(pattern.toLowerCase());
}

export function findStoryByPattern(stories: EnrichedStory[], pattern: string): EnrichedStory | undefined {
  return stories.find((story) => matchesPattern(story, pattern));
}

export function clusterForStory(groups: StoryGroup[], story: EnrichedStory): StoryGroup | undefined {
  return groups.find(
    (group) =>
      group.type === 'detected' &&
      group.stories.some((s) => s.url === story.url && s.title === story.title),
  );
}

export function loadStoriesFromRegressionFixture(fixture: RegressionFixture): EnrichedStory[] {
  return fixture.stories.map((row) => ({
    title: row.title ?? '',
    url: row.url ?? '',
    host: row.host,
    publishedAt: row.publishedAt,
    description: row.description ?? '',
    articleText: row.articleText ?? '',
  }));
}

export function assertExpectedClusters(
  groups: StoryGroup[],
  stories: EnrichedStory[],
  expected: ExpectedCluster[],
): string[] {
  const failures: string[] = [];
  const detected = groups.filter((g) => g.type === 'detected');

  for (const spec of expected) {
    const labelRe = new RegExp(spec.labelPattern, 'i');
    const cluster =
      detected.find((g) => {
        if (g.stories.length < spec.minSize) return false;
        if (!spec.requiredStoryPatterns.every((pattern) => g.stories.some((story) => matchesPattern(story, pattern)))) {
          return false;
        }
        if (spec.exclusiveStoryPatterns) {
          return g.stories.every((story) =>
            spec.exclusiveStoryPatterns!.some((pattern) => matchesPattern(story, pattern)),
          );
        }
        return true;
      }) ??
      detected.find((g) => {
        if (!spec.requiredStoryPatterns.every((pattern) => g.stories.some((story) => matchesPattern(story, pattern)))) {
          return false;
        }
        if (spec.exclusiveStoryPatterns) {
          return g.stories.every((story) =>
            spec.exclusiveStoryPatterns!.some((pattern) => matchesPattern(story, pattern)),
          );
        }
        return true;
      });

    if (!cluster) {
      failures.push(
        `[${spec.id}] no detected cluster contains all patterns ${JSON.stringify(spec.requiredStoryPatterns)} (labels: ${detected.map((g) => g.label).join(' | ')})`,
      );
      continue;
    }

    if (cluster.stories.length < spec.minSize) {
      failures.push(`[${spec.id}] cluster "${cluster.label}" has ${cluster.stories.length} stories, need >= ${spec.minSize}`);
    }

    if (!labelRe.test(cluster.label) && spec.labelPattern !== '.') {
      failures.push(`[${spec.id}] cluster label "${cluster.label}" does not match /${spec.labelPattern}/i`);
    }

    for (const pattern of spec.requiredStoryPatterns) {
      if (!cluster.stories.some((story) => matchesPattern(story, pattern))) {
        failures.push(`[${spec.id}] cluster "${cluster.label}" missing story matching "${pattern}"`);
      }
    }

    console.log(`  ✓ ${spec.id}: "${cluster.label}" (${cluster.stories.length} stories)`);
  }

  return failures;
}

export function assertMustNotShareCluster(
  groups: StoryGroup[],
  stories: EnrichedStory[],
  specs: ClusterExpectations['mustNotShareCluster'],
): string[] {
  const failures: string[] = [];
  for (const spec of specs) {
    const [patternA, patternB] = spec.storyPatterns;
    if (!patternA || !patternB) continue;
    const storyA = findStoryByPattern(stories, patternA);
    const storyB = findStoryByPattern(stories, patternB);
    if (!storyA || !storyB) {
      console.log(`  ○ ${spec.id}: skipped (story not in regression fixture)`);
      continue;
    }
    const clusterA = clusterForStory(groups, storyA);
    const clusterB = clusterForStory(groups, storyB);
    if (clusterA && clusterB && clusterA.label === clusterB.label) {
      failures.push(
        `[${spec.id}] "${patternA}" and "${patternB}" incorrectly share cluster "${clusterA.label}"`,
      );
      continue;
    }
    console.log(`  ✓ ${spec.id}: unrelated stories not clustered together`);
  }
  return failures;
}

export function assertMustStayIndependent(
  groups: StoryGroup[],
  stories: EnrichedStory[],
  specs: ClusterExpectations['mustStayIndependent'],
): string[] {
  const failures: string[] = [];
  for (const spec of specs) {
    const story = findStoryByPattern(stories, spec.storyPattern);
    if (!story) {
      console.log(`  ○ ${spec.id}: skipped (story not in regression fixture)`);
      continue;
    }
    const cluster = clusterForStory(groups, story);
    if (cluster) {
      failures.push(
        `[${spec.id}] "${spec.storyPattern}" should stay independent but is in cluster "${cluster.label}"`,
      );
      continue;
    }
    console.log(`  ✓ ${spec.id}: "${spec.storyPattern}" remains independent`);
  }
  return failures;
}

export function assertForbiddenMegaClusters(
  groups: StoryGroup[],
  stories: EnrichedStory[],
  specs: ClusterExpectations['forbiddenMegaClusters'],
): string[] {
  const failures: string[] = [];
  if (!specs?.length) return failures;

  const detected = groups.filter((g) => g.type === 'detected');
  for (const spec of specs) {
    const labelRe = new RegExp(spec.labelPattern, 'i');
    for (const cluster of detected) {
      if (!labelRe.test(cluster.label)) continue;
      for (const pattern of spec.mustNotContainPatterns) {
        const hit = cluster.stories.find((story) => matchesPattern(story, pattern));
        if (hit) {
          failures.push(
            `[${spec.id}] cluster "${cluster.label}" must not contain story matching "${pattern}" (${hit.url})`,
          );
        }
      }
    }
    if (!failures.some((f) => f.startsWith(`[${spec.id}]`))) {
      console.log(`  ✓ ${spec.id}: no forbidden stories under matching label`);
    }
  }
  return failures;
}

export function assertForbiddenClusterLabels(
  groups: StoryGroup[],
  specs: ClusterExpectations['forbiddenClusterLabels'],
): string[] {
  const failures: string[] = [];
  if (!specs?.length) return failures;

  const detected = groups.filter((g) => g.type === 'detected');
  for (const spec of specs) {
    const labelRe = new RegExp(spec.labelPattern, 'i');
    const hits = detected.filter((cluster) => labelRe.test(cluster.label));
    if (hits.length > 0) {
      const summary = hits.map((cluster) => `"${cluster.label}" (${cluster.stories.length})`).join(', ');
      failures.push(
        `[${spec.id}] ${hits.length} detected cluster(s) must not match /${spec.labelPattern}/i — ${summary}`,
      );
      continue;
    }
    console.log(`  ✓ ${spec.id}: no cluster labeled /${spec.labelPattern}/i`);
  }
  return failures;
}

export function assertForbiddenStoryTitlePatterns(
  stories: EnrichedStory[],
  specs: ClusterExpectations['forbiddenStoryTitlePatterns'],
): string[] {
  const failures: string[] = [];
  if (!specs?.length) return failures;

  for (const spec of specs) {
    const titleRe = new RegExp(spec.titlePattern, 'i');
    const hits = stories.filter((story) => titleRe.test(story.title));
    if (hits.length > 0) {
      const sample = hits
        .slice(0, 3)
        .map((story) => `"${story.title.slice(0, 60)}" (${story.url})`)
        .join('; ');
      failures.push(
        `[${spec.id}] ${hits.length} story title(s) match /${spec.titlePattern}/i — e.g. ${sample}`,
      );
      continue;
    }
    console.log(`  ✓ ${spec.id}: no story title matches /${spec.titlePattern}/i`);
  }
  return failures;
}

export function draftExpectationsFromGroups(groups: StoryGroup[]): ClusterExpectations {
  const expectedClusters: ExpectedCluster[] = [];
  for (const group of groups.filter((g) => g.type === 'detected')) {
    const slugPatterns = group.stories
      .map((story) => {
        try {
          return new URL(story.url).pathname.split('/').filter(Boolean).at(-1)?.slice(0, 48) ?? story.host ?? 'story';
        } catch {
          return story.host ?? 'story';
        }
      })
      .slice(0, 4);
    expectedClusters.push({
      id: group.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cluster',
      labelPattern: group.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      minSize: group.stories.length,
      requiredStoryPatterns: slugPatterns,
    });
  }
  return {
    _description: 'Generated snapshot — edit requiredStoryPatterns and add mustNotShareCluster before committing.',
    expectedClusters,
    mustNotShareCluster: [],
    mustStayIndependent: [],
  };
}
