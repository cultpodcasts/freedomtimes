/**
 * Capture the enriched story set render:html uses (720h window, dedupe, figurative filter).
 * Writes tests/fixtures/cluster-stories-regression.json for npm run test:clusters.
 *
 *   npm run sync:cluster-regression
 *
 * Re-run after discovery/pipeline changes or when you want the regression corpus refreshed.
 * Uses HTTP cache populated by prior render:html / dev runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnrichedStoriesForClustering } from './render-cult-news-html.tsx';

const ROOT = new URL('../', import.meta.url);
const OUTPUT_PATH = new URL('tests/fixtures/cluster-stories-regression.json', ROOT);

async function main(): Promise<void> {
  const { stories, renderMaxAgeHours, draftSource, draftCount } = await loadEnrichedStoriesForClustering();
  const fixture = {
    generatedAt: new Date().toISOString(),
    renderMaxAgeHours: renderMaxAgeHours ?? null,
    draftSource,
    draftCount,
    storyCount: stories.length,
    stories: stories.map((story) => ({
      title: story.title,
      url: story.url,
      host: story.host,
      publishedAt: story.publishedAt,
      description: story.description ?? '',
      articleText: story.articleText ?? '',
    })),
  };

  mkdirSync(new URL('tests/fixtures/', ROOT), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
  console.log(
    `[sync:cluster-regression] wrote ${stories.length} stories (window=${renderMaxAgeHours ?? 'unset'}h) → ${fileURLToPath(OUTPUT_PATH)}`,
  );
}

main().catch((error: unknown) => {
  console.error('[sync:cluster-regression] failed', error);
  process.exitCode = 1;
});
