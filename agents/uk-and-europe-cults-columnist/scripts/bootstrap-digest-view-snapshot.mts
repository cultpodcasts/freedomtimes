/**
 * One-off: build digest-view-snapshot.json from existing corpus (slow first run).
 * After render:html this file is written automatically.
 */
import { writeFileSync } from 'node:fs';
import {
  loadDigestCorpus,
  loadWrongClusterUrlKeys,
  VIEW_SNAPSHOT_PATH,
  type DigestViewSnapshot,
} from '../src/digestView.ts';

const corpus = loadDigestCorpus();
if (!corpus) {
  console.error('No digest corpus. Run: npm run render:html');
  process.exit(1);
}

const renderModule = await import('./render-cult-news-html.tsx');
const { autoGroups, citedStories } = renderModule.buildDigestAutoGroupsFromStories(
  corpus.stories,
  loadWrongClusterUrlKeys(),
);

const snapshot: DigestViewSnapshot = {
  corpusGeneratedAt: corpus.generatedAt,
  generatedAt: new Date().toISOString(),
  autoGroups,
  citedStoryCount: citedStories.length,
};

writeFileSync(VIEW_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
console.log(`[bootstrap] wrote ${VIEW_SNAPSHOT_PATH} (${autoGroups.length} groups, ${citedStories.length} stories)`);
