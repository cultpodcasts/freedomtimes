/**
 * Print current auto-clusters from the regression fixture as a draft expectations file.
 *
 *   npm run cluster:print-expectations
 *   npm run cluster:print-expectations > tests/cluster-expectations.draft.json
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyStories } from './render-cult-news-html.tsx';
import {
  draftExpectationsFromGroups,
  loadStoriesFromRegressionFixture,
  type RegressionFixture,
} from './clusterTestLib.ts';

const ROOT = new URL('../', import.meta.url);
const FIXTURE_PATH = new URL('tests/fixtures/cluster-stories-regression.json', ROOT);
const WRITE_PATH = new URL('tests/cluster-expectations.draft.json', ROOT);

function main(): void {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`Missing ${fileURLToPath(FIXTURE_PATH)} — run npm run sync:cluster-regression first`);
    process.exitCode = 1;
    return;
  }

  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as RegressionFixture;
  const stories = loadStoriesFromRegressionFixture(fixture);
  const { groups } = classifyStories(stories);
  const draft = draftExpectationsFromGroups(groups);
  draft.renderMaxAgeHours = fixture.renderMaxAgeHours ?? 720;
  draft._description =
    'Draft from current auto-clustering. Edit requiredStoryPatterns, add mustNotShareCluster, then replace cluster-expectations.json.';

  const json = `${JSON.stringify(draft, null, 2)}\n`;
  if (process.argv.includes('--write')) {
    writeFileSync(WRITE_PATH, json, 'utf-8');
    console.log(`[cluster:print-expectations] wrote ${fileURLToPath(WRITE_PATH)}`);
    return;
  }

  process.stdout.write(json);
}

main();
