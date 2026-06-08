/**
 * Build reports/review-report-latest.json from corpus + false-positives + cluster layout.
 */
import { writeReviewReport } from '../src/reviewReport.ts';

const report = await writeReviewReport();
console.log(
  `[build-review-report] wrote ${report.visibleStoryCount} stories in ${report.clusters.length} clusters`,
);
console.log(`[build-review-report] layout=${report.layoutSource} excluded FP=${report.excludedFalsePositiveCount}`);
