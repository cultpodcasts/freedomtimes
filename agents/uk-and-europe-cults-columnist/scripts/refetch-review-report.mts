/**
 * Re-fetch article text for stories in review-report-latest.json only.
 * Updates properNouns with cleaned report extraction (no full render:html).
 */
import { refetchReviewReport } from '../src/reviewReport.ts';

const report = await refetchReviewReport({
  onProgress: (index, total, story) => {
    console.log(`[refetch-review-report] [${index}/${total}] ${story.host ?? story.url}`);
  },
  onStoryError: (story, error) => {
    console.error(`[refetch-review-report] failed ${story.url}:`, error);
  },
});

console.log(`[refetch-review-report] wrote ${report.visibleStoryCount} stories to reports/review-report-latest.json`);
