/**
 * Cluster regression tests on the real render story set (720h window by default).
 *
 * Workflow:
 *   1. npm run sync:cluster-regression   # refresh fixture from drafts + http cache
 *   2. Edit tests/cluster-expectations.json (desired clusters + anti-regression rules)
 *   3. npm run test:clusters
 *
 * Optional: npm run cluster:print-expectations -- --write  # draft expectations from current auto output
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyStories } from './render-cult-news-html.tsx';
import {
  assertExpectedClusters,
  assertForbiddenClusterLabels,
  assertForbiddenStoryTitlePatterns,
  assertForbiddenMegaClusters,
  assertMustBeClustered,
  assertMustNotShareCluster,
  assertMustStayIndependent,
  findStoryByPattern,
  loadStoriesFromRegressionFixture,
  type ClusterExpectations,
  type RegressionFixture,
} from './clusterTestLib.ts';

const ROOT = new URL('../', import.meta.url);
const FIXTURE_PATH = new URL('tests/fixtures/cluster-stories-regression.json', ROOT);
const EXPECTATIONS_PATH = new URL('tests/cluster-expectations.json', ROOT);

function main(): void {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`[test:clusters] missing ${fileURLToPath(FIXTURE_PATH)}`);
    console.error('[test:clusters] run: npm run sync:cluster-regression');
    process.exitCode = 1;
    return;
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as RegressionFixture;
  const expectations = JSON.parse(readFileSync(EXPECTATIONS_PATH, 'utf-8')) as ClusterExpectations;
  const stories = loadStoriesFromRegressionFixture(fixture);

  if (expectations.renderMaxAgeHours && fixture.renderMaxAgeHours !== expectations.renderMaxAgeHours) {
    console.warn(
      `[test:clusters] fixture window=${fixture.renderMaxAgeHours}h but expectations specify ${expectations.renderMaxAgeHours}h — re-run sync:cluster-regression after setting CULT_NEWS_RENDER_MAX_AGE_HOURS`,
    );
  }

  console.log(`[test:clusters] fixture: ${fileURLToPath(FIXTURE_PATH)}`);
  console.log(
    `[test:clusters] ${stories.length} stories (generated ${fixture.generatedAt}, window=${fixture.renderMaxAgeHours ?? 'unset'}h, drafts=${fixture.draftSource}/${fixture.draftCount})\n`,
  );

  const { groups, detection } = classifyStories(stories);
  const detected = groups.filter((g) => g.type === 'detected');
  console.log(`[test:clusters] auto-clustering → ${detected.length} detected clusters\n`);

  if (process.env.CLUSTER_TEST_DEBUG) {
    for (const group of detection.groups) {
      const urls = [...group.storyIndexes].map((idx) => stories[idx]?.url.split('/').pop()?.slice(0, 40));
      console.log(`[debug] "${group.label}" idx=[${[...group.storyIndexes].join(',')}] ${urls.join(' | ')}`);
    }
    console.log('');
  }

  for (const group of detected) {
    console.log(`  cluster "${group.label}" (${group.stories.length})`);
    for (const story of group.stories) {
      console.log(`    - ${story.title.slice(0, 75)}`);
    }
  }
  console.log('');

  const failures = [
    ...assertExpectedClusters(groups, stories, expectations.expectedClusters),
    ...assertMustNotShareCluster(groups, stories, expectations.mustNotShareCluster),
    ...assertMustStayIndependent(groups, stories, expectations.mustStayIndependent),
    ...assertMustBeClustered(groups, stories, expectations.mustBeClustered),
    ...assertForbiddenMegaClusters(groups, stories, expectations.forbiddenMegaClusters),
    ...assertForbiddenClusterLabels(groups, expectations.forbiddenClusterLabels),
    ...assertForbiddenStoryTitlePatterns(stories, expectations.forbiddenStoryTitlePatterns),
  ];

  if (failures.length > 0) {
    console.error(`\n[test:clusters] FAILED (${failures.length} assertion(s)):`);
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`);
    }
    console.error('\n[test:clusters] fix clustering logic, or refresh expectations after deliberate layout changes.');
    process.exitCode = 1;
    return;
  }

  const activeNegativeChecks = expectations.mustNotShareCluster.filter((spec) => {
    const [a, b] = spec.storyPatterns;
    return Boolean(a && b && findStoryByPattern(stories, a) && findStoryByPattern(stories, b));
  }).length;

  console.log(
    `\n[test:clusters] PASSED (${expectations.expectedClusters.length} cluster checks, ${activeNegativeChecks} separation checks)`,
  );
}

main();
