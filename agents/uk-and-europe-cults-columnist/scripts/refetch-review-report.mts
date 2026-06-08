/**
 * Re-fetch article text for stories in review-report-latest.json only.
 * Updates properNouns with cleaned report extraction (no full render:html).
 */
import { cleanArticlePlainText } from '../src/articleContent.ts';
import { fetchStoryMeta } from './render-cult-news-html.helpers.ts';
import {
  loadReviewReportLatest,
  saveReviewReport,
  type ReviewReportPayload,
  type ReviewReportStory,
} from '../src/reviewReport.ts';
import {
  extractReportProperNouns,
  matchReportProperNounAliases,
} from '../src/reportProperNouns.ts';

function refreshStorySignals(story: ReviewReportStory): void {
  const lang = (story.htmlLang || 'en').split('-')[0] || 'en';
  const sourceText = `${story.title} ${story.articleText}`;
  story.signals.properNouns = extractReportProperNouns(sourceText, lang);
  story.signals.matchedAliases = matchReportProperNounAliases(story.signals.properNouns);
}

async function refetchStory(story: ReviewReportStory): Promise<void> {
  const meta = await fetchStoryMeta(story.url, { contentMirrorUrl: story.contentMirrorUrl });
  if (meta.title?.trim()) {
    story.title = meta.title.trim();
  }
  if (meta.description?.trim()) {
    story.description = meta.description.trim();
  }
  if (meta.articleText?.trim()) {
    story.articleText = cleanArticlePlainText(meta.articleText);
  }
  if (meta.publishedAt) {
    story.publishedAt = meta.publishedAt;
  }
  if (meta.htmlLang) {
    story.htmlLang = meta.htmlLang;
  }
  if (meta.contentMirrorUrl) {
    story.contentMirrorUrl = meta.contentMirrorUrl;
  }
  refreshStorySignals(story);
}

async function main(): Promise<void> {
  const report = loadReviewReportLatest();
  if (!report) {
    console.error('[refetch-review-report] No reports/review-report-latest.json — run: npm run build:review-report');
    process.exit(1);
  }

  const stories = report.clusters.flatMap((cluster) => cluster.stories);
  console.log(`[refetch-review-report] refetching ${stories.length} URLs from review report`);

  let index = 0;
  for (const story of stories) {
    index += 1;
    console.log(`[refetch-review-report] [${index}/${stories.length}] ${story.host ?? story.url}`);
    try {
      await refetchStory(story);
    } catch (err) {
      console.error(`[refetch-review-report] failed ${story.url}:`, err);
      refreshStorySignals(story);
    }
  }

  const updated: ReviewReportPayload = {
    ...report,
    generatedAt: new Date().toISOString(),
    refetchedAt: new Date().toISOString(),
  };
  saveReviewReport(updated);
  console.log(`[refetch-review-report] wrote ${updated.visibleStoryCount} stories to reports/review-report-latest.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
