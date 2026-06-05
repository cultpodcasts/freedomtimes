/**
 * Sync real digest story text into cluster integration fixtures.
 * Uses the same fetchStoryMeta path as render:html (http cache when populated).
 *
 *   npm run sync:cluster-fixtures
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DRAFTS_ARCHIVE_PATH,
  fetchStoryMeta,
  type DraftStory,
} from './render-cult-news-html.helpers.ts';

const ROOT = new URL('../', import.meta.url);
const URLS_PATH = new URL('tests/cluster-fixture-urls.json', ROOT);
const OUTPUT_PATH = new URL('tests/fixtures/cluster-stories-real.json', ROOT);

type FixtureRow = {
  title: string;
  url: string;
  host: string;
  publishedAt: string;
  description: string;
  articleText: string;
};

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function loadDraftByUrl(url: string): DraftStory | undefined {
  if (!existsSync(DRAFTS_ARCHIVE_PATH)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(DRAFTS_ARCHIVE_PATH, 'utf-8')) as
      | Array<{ draft?: DraftStory; url?: string }>
      | { entries?: Array<{ draft?: DraftStory; url?: string }> };
    const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
    const key = url.toLowerCase().replace(/^https:\/\/www\./, 'https://');
    for (const entry of entries) {
      const draft = entry.draft ?? (entry as DraftStory);
      const candidate = draft?.url ?? entry.url;
      if (!candidate) continue;
      const normalized = candidate.toLowerCase().replace(/^https:\/\/www\./, 'https://');
      if (normalized === key || normalized.includes(getSlugTail(url)) || key.includes(getSlugTail(candidate))) {
        return draft;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getSlugTail(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

async function syncOne(url: string): Promise<FixtureRow> {
  const draft = loadDraftByUrl(url);
  const meta = await fetchStoryMeta(url, { contentMirrorUrl: draft?.contentMirrorUrl });
  const title = meta.title?.trim() || draft?.title?.trim() || url;
  const publishedAt = meta.publishedAt || draft?.publishedAt || new Date().toISOString();
  const articleText = meta.articleText?.trim() || '';
  if (articleText.length < 80) {
    console.warn(`[sync:cluster-fixtures] short body (${articleText.length} chars) for ${url}`);
  }
  return {
    title,
    url,
    host: getHostname(url),
    publishedAt,
    description: meta.description?.trim() ?? '',
    articleText,
  };
}

function applyPaywallFallbacks(fixtures: FixtureRow[]): void {
  const bfmtv = fixtures.find((row) => row.host === 'bfmtv.com' && row.articleText.length >= 200);
  const lePays = fixtures.find((row) => row.host === 'le-pays.fr');
  if (bfmtv && lePays && lePays.articleText.length < 80) {
    lePays.articleText = bfmtv.articleText;
    lePays.description = lePays.description || bfmtv.description;
    console.warn(
      `[sync:cluster-fixtures] le-pays.fr paywall — copied AFP body from bfmtv.com (${lePays.articleText.length} chars)`,
    );
  }
}

async function main(): Promise<void> {
  const { urls } = JSON.parse(readFileSync(URLS_PATH, 'utf-8')) as { urls: string[] };
  console.log(`[sync:cluster-fixtures] syncing ${urls.length} URLs from digest…`);
  const fixtures: FixtureRow[] = [];
  for (const url of urls) {
    console.log(`  fetch ${url.slice(0, 72)}…`);
    fixtures.push(await syncOne(url));
  }
  applyPaywallFallbacks(fixtures);
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf-8');
  console.log(`[sync:cluster-fixtures] wrote ${fixtures.length} stories → ${fileURLToPath(OUTPUT_PATH)}`);
}

main().catch((error: unknown) => {
  console.error('[sync:cluster-fixtures] failed', error);
  process.exitCode = 1;
});
