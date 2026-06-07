/**
 * Digest exclusion regression — stories that must not appear in cult-news-latest.html.
 *
 *   npm run test:digest-exclusion
 *   npm run test:digest-exclusion:fixture   # skip live corpus check (fast)
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnrichedStoriesForClustering } from './render-cult-news-html.tsx';
import {
  assertMustExcludeFromDigest,
  assertMustNotAppearInRenderCorpus,
  type DigestExclusionExpectations,
  type DigestSnippetFixture,
} from './digestExclusionTestLib.ts';
import type { RegressionFixture } from './clusterTestLib.ts';

const ROOT = new URL('../', import.meta.url);
const EXPECTATIONS_PATH = new URL('tests/digest-exclusion-expectations.json', ROOT);
const SNIPPETS_PATH = new URL('tests/fixtures/digest-exclusion-snippets.json', ROOT);
const CLUSTER_FIXTURE_PATH = new URL('tests/fixtures/cluster-stories-regression.json', ROOT);

async function main(): Promise<void> {
  const expectations = JSON.parse(readFileSync(EXPECTATIONS_PATH, 'utf-8')) as DigestExclusionExpectations;
  const snippets = existsSync(SNIPPETS_PATH)
    ? (JSON.parse(readFileSync(SNIPPETS_PATH, 'utf-8')) as DigestSnippetFixture)
    : null;
  const clusterFixture = existsSync(CLUSTER_FIXTURE_PATH)
    ? (JSON.parse(readFileSync(CLUSTER_FIXTURE_PATH, 'utf-8')) as RegressionFixture)
    : null;

  console.log('[test:digest-exclusion] getDigestExclusionReason checks\n');
  const exclusionFailures = assertMustExcludeFromDigest(
    expectations.mustExcludeFromDigest,
    clusterFixture,
    snippets,
  );

  const failures = [...exclusionFailures];

  if (process.env.DIGEST_TEST_SKIP_LIVE !== '1') {
    console.log('\n[test:digest-exclusion] live render corpus checks\n');
    const loaded = await loadEnrichedStoriesForClustering();
    failures.push(
      ...assertMustNotAppearInRenderCorpus(expectations.mustExcludeFromDigest, loaded.stories),
    );
  } else {
    console.log('\n[test:digest-exclusion] live corpus check skipped (DIGEST_TEST_SKIP_LIVE=1)\n');
  }

  if (failures.length > 0) {
    console.error(`\n[test:digest-exclusion] FAILED (${failures.length} assertion(s)):`);
    for (const failure of failures) {
      console.error(`  ✗ ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\n[test:digest-exclusion] PASSED (${expectations.mustExcludeFromDigest.length} exclusion checks)`);
}

main().catch((error: unknown) => {
  console.error('[test:digest-exclusion] failed', error);
  process.exitCode = 1;
});
