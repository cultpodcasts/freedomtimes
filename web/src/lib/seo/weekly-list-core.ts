/** Pure helpers for the weekly-summary list (unit tested; no emdash runtime import). */
import { readEmDashPublishedAt } from '../content/emdashTimestamps';
import { WEEKLY_SUMMARY_SLUG_PREFIX, isWeeklySummarySlug, readIsoDate, sortWeeklies } from './article-seo';

export interface WeeklySummaryRecord {
	slug: string;
	title: string;
	/** Sort key: coverage_start (London date), else publishedAt. */
	sortDate: string;
	coverageStart: string | null;
	coverageEnd: string | null;
	publishedAt: string | null;
	excerpt: string | null;
}

/** Slug range for the prefix filter ('.' is the next code point after '-'). */
export function weeklySlugRange(): { gte: string; lt: string } {
	const prefix = WEEKLY_SUMMARY_SLUG_PREFIX;
	const last = prefix.charCodeAt(prefix.length - 1);
	return { gte: prefix, lt: prefix.slice(0, -1) + String.fromCharCode(last + 1) };
}

export function toWeeklyRecords(entries: Array<{ id: string; data: Record<string, unknown> }>): WeeklySummaryRecord[] {
	const out: WeeklySummaryRecord[] = [];
	for (const entry of entries) {
		const data = entry.data;
		const slug = typeof data.slug === 'string' && data.slug.length > 0 ? data.slug : entry.id;
		if (!isWeeklySummarySlug(slug)) continue;
		const coverageStart = readIsoDate(data.coverage_start);
		const publishedAt = readEmDashPublishedAt(entry as never);
		out.push({
			slug,
			title: typeof data.title === 'string' && data.title.length > 0 ? data.title : slug,
			sortDate: coverageStart ?? publishedAt ?? '',
			coverageStart,
			coverageEnd: readIsoDate(data.coverage_end),
			publishedAt,
			excerpt: typeof data.excerpt === 'string' ? data.excerpt : null,
		});
	}
	return sortWeeklies(out) as WeeklySummaryRecord[];
}

