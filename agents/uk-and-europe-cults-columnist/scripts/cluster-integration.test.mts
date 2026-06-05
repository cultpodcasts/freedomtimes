/**
 * Integration tests for story clustering (synthetic + real digest fixtures).
 * Real URLs: tests/cluster-fixture-urls.json — refresh after render:html:
 *
 *   npm run sync:cluster-fixtures
 *   npm run test:clusters
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EnrichedStory } from './render-cult-news-html.helpers.ts';
import { classifyStories, type StoryGroup } from './render-cult-news-html.tsx';

const ROOT = new URL('../', import.meta.url);
const SYNTHETIC_FIXTURES_PATH = new URL('tests/fixtures/cluster-stories-synthetic.json', ROOT);
const REAL_FIXTURES_PATH = new URL('tests/fixtures/cluster-stories-real.json', ROOT);
const EXPECTATIONS_PATH = new URL('tests/cluster-expectations.json', ROOT);

type ExpectedCluster = {
  id: string;
  labelPattern: string;
  minSize: number;
  requiredStoryPatterns: string[];
  exclusiveStoryPatterns?: string[];
};

type ExpectationsFile = {
  expectedClusters: ExpectedCluster[];
  mustNotShareCluster: Array<{ id: string; storyPatterns: [string, string] | string[] }>;
  mustStayIndependent: Array<{ id: string; storyPattern: string }>;
};

function loadFixtures(): EnrichedStory[] {
  const synthetic = JSON.parse(readFileSync(SYNTHETIC_FIXTURES_PATH, 'utf-8')) as Array<Record<string, string>>;
  const real = existsSync(REAL_FIXTURES_PATH)
    ? (JSON.parse(readFileSync(REAL_FIXTURES_PATH, 'utf-8')) as Array<Record<string, string>>)
    : [];
  const raw = [...synthetic, ...real];
  return raw.map((row) => ({
    title: row.title ?? '',
    url: row.url ?? '',
    host: row.host,
    publishedAt: row.publishedAt,
    description: row.description ?? '',
    articleText: row.articleText ?? '',
  }));
}

function storyHaystack(story: EnrichedStory): string {
  return `${story.title} ${story.url} ${story.description} ${story.articleText}`.toLowerCase();
}

function matchesPattern(story: EnrichedStory, pattern: string): boolean {
  const hay = storyHaystack(story);
  return hay.includes(pattern.toLowerCase());
}

function findStoryByPattern(stories: EnrichedStory[], pattern: string): EnrichedStory | undefined {
  return stories.find((story) => matchesPattern(story, pattern));
}

function clusterForStory(groups: StoryGroup[], story: EnrichedStory): StoryGroup | undefined {
  return groups.find(
    (group) =>
      group.type === 'detected' &&
      group.stories.some((s) => s.url === story.url && s.title === story.title),
  );
}

function assertExpectedClusters(groups: StoryGroup[], stories: EnrichedStory[], expected: ExpectedCluster[]): string[] {
  const failures: string[] = [];
  const detected = groups.filter((g) => g.type === 'detected');

  for (const spec of expected) {
    const labelRe = new RegExp(spec.labelPattern, 'i');
    const matchingClusters = detected.filter((g) => labelRe.test(g.label));

    const cluster =
      matchingClusters.find((g) => {
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
        `[${spec.id}] no detected cluster contains all patterns ${JSON.stringify(spec.requiredStoryPatterns)} (labels seen: ${detected.map((g) => g.label).join(' | ')})`,
      );
      continue;
    }

    if (cluster.stories.length < spec.minSize) {
      failures.push(`[${spec.id}] cluster "${cluster.label}" has ${cluster.stories.length} stories, need >= ${spec.minSize}`);
    }

    if (!labelRe.test(cluster.label) && spec.labelPattern !== '.') {
      failures.push(
        `[${spec.id}] cluster label "${cluster.label}" does not match /${spec.labelPattern}/i`,
      );
    }

    for (const pattern of spec.requiredStoryPatterns) {
      if (!cluster.stories.some((story) => matchesPattern(story, pattern))) {
        failures.push(`[${spec.id}] cluster "${cluster.label}" missing story matching "${pattern}"`);
      }
    }

    console.log(
      `  ✓ ${spec.id}: "${cluster.label}" (${cluster.stories.length} stories)`,
    );
  }

  return failures;
}

function assertMustNotShareCluster(groups: StoryGroup[], stories: EnrichedStory[], specs: ExpectationsFile['mustNotShareCluster']): string[] {
  const failures: string[] = [];
  for (const spec of specs) {
    const [patternA, patternB] = spec.storyPatterns;
    if (!patternA || !patternB) continue;
    const storyA = findStoryByPattern(stories, patternA);
    const storyB = findStoryByPattern(stories, patternB);
    if (!storyA || !storyB) {
      failures.push(`[${spec.id}] fixture missing stories for patterns ${patternA} / ${patternB}`);
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

function assertMustStayIndependent(groups: StoryGroup[], stories: EnrichedStory[], specs: ExpectationsFile['mustStayIndependent']): string[] {
  const failures: string[] = [];
  for (const spec of specs) {
    const story = findStoryByPattern(stories, spec.storyPattern);
    if (!story) {
      failures.push(`[${spec.id}] fixture missing story matching "${spec.storyPattern}"`);
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

function main(): void {
  console.log('[test:clusters] synthetic:', fileURLToPath(SYNTHETIC_FIXTURES_PATH));
  console.log('[test:clusters] real:', existsSync(REAL_FIXTURES_PATH) ? fileURLToPath(REAL_FIXTURES_PATH) : '(missing — run npm run sync:cluster-fixtures)');
  const stories = loadFixtures();
  const expectations = JSON.parse(readFileSync(EXPECTATIONS_PATH, 'utf-8')) as ExpectationsFile;

  const { groups, detection } = classifyStories(stories);
  const detected = groups.filter((g) => g.type === 'detected');
  console.log(`[test:clusters] ${stories.length} fixture stories → ${detected.length} detected clusters\n`);

  if (process.env.CLUSTER_TEST_DEBUG) {
    const debugPairs = [
      ['13368200', '13371318'],
      ['cull-pets', 'animaux-compagnie'],
      ['campania-young-festival', 'celico-cronenberg'],
    ];
    for (const pair of debugPairs) {
      const patternA = pair[0];
      const patternB = pair[1];
      if (!patternA || !patternB) continue;
      const storyA = findStoryByPattern(stories, patternA);
      const storyB = findStoryByPattern(stories, patternB);
      if (!storyA || !storyB) continue;
      const idxA = stories.findIndex((s) => s.url === storyA.url);
      const idxB = stories.findIndex((s) => s.url === storyB.url);
      const linked = detection.edges.get(idxA)?.has(idxB) ?? false;
      const featA = detection.features[idxA];
      const featB = detection.features[idxB];
      const neighborsA = [...(detection.edges.get(idxA) ?? [])];
      const neighborsB = [...(detection.edges.get(idxB) ?? [])];
      console.log(
        `[debug] ${patternA} ↔ ${patternB}: edge=${linked} langs=${featA?.language}/${featB?.language}`,
      );
      console.log(`        neighborsA=[${neighborsA.join(',')}] neighborsB=[${neighborsB.join(',')}]`);
    }
    console.log('[debug] raw detected groups:');
    for (const group of detection.groups) {
      const urls = [...group.storyIndexes].map((idx) => stories[idx]?.url.split('/').pop()?.slice(0, 40));
      console.log(`        "${group.label}" idx=[${[...group.storyIndexes].join(',')}] ${urls.join(' | ')}`);
    }
    console.log('');
  }

  for (const group of detected) {
    console.log(`  cluster "${group.label}" (${group.stories.length})`);
    for (const s of group.stories) {
      console.log(`    - ${s.title.slice(0, 75)}`);
    }
  }
  console.log('');

  const failures = [
    ...assertExpectedClusters(groups, stories, expectations.expectedClusters),
    ...assertMustNotShareCluster(groups, stories, expectations.mustNotShareCluster),
    ...assertMustStayIndependent(groups, stories, expectations.mustStayIndependent),
  ];

  if (failures.length > 0) {
    console.error(`\n[test:clusters] FAILED (${failures.length} assertion(s)):`);
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\n[test:clusters] PASSED (${expectations.expectedClusters.length} cluster checks)`);
}

main();
