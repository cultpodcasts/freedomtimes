/**
 * Shared, cached list of published weekly summaries (prev/next links on
 * weekly summary articles).
 *
 * - The query is filtered in SQL to the `weekly-summary-` slug prefix
 *   (`slug >= 'weekly-summary-' AND slug < 'weekly-summary.'`), so it never
 *   scans unrelated posts.
 * - The sorted result is cached server-side in `caches.default` for
 *   WEEKLY_LIST_TTL_SECONDS (internal key, never served to clients), so most
 *   renders cost no DB read.
 * - A warning is logged when the query cap is hit, so truncation is visible.
 */
import { getEmDashCollection } from 'emdash';

import { toWeeklyRecords, weeklySlugRange, type WeeklySummaryRecord } from './weekly-list-core';
export type { WeeklySummaryRecord };

export const WEEKLY_LIST_TTL_SECONDS = 300;
export const WEEKLY_LIST_QUERY_LIMIT = 1000;



function edgeCache(): Cache | null {
	const g = globalThis as unknown as { caches?: { default?: Cache } };
	return g.caches?.default ?? null;
}

const CACHE_KEY = 'https://ft-internal.invalid/__ft-weekly-list/v1';

/** Oldest → newest. Throws on query error (callers decide how to degrade). */
export async function getWeeklySummaries(): Promise<WeeklySummaryRecord[]> {
	const cache = edgeCache();
	if (cache) {
		try {
			const hit = await cache.match(new Request(CACHE_KEY));
			if (hit) return (await hit.json()) as WeeklySummaryRecord[];
		} catch (err) {
			console.warn('[weekly-list] cache match failed', String(err));
		}
	}
	const { entries, error } = await getEmDashCollection('posts', {
		status: 'published',
		limit: WEEKLY_LIST_QUERY_LIMIT,
		where: { slug: weeklySlugRange() },
		orderBy: { published_at: 'desc' },
	} as never);
	if (error) throw error;
	if (entries.length >= WEEKLY_LIST_QUERY_LIMIT) {
		console.warn('[weekly-list] query cap reached; list truncated', JSON.stringify({ limit: WEEKLY_LIST_QUERY_LIMIT }));
	}
	const records = toWeeklyRecords(entries as Array<{ id: string; data: Record<string, unknown> }>);
	if (cache) {
		try {
			await cache.put(new Request(CACHE_KEY), new Response(JSON.stringify(records), {
				headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${WEEKLY_LIST_TTL_SECONDS}` },
			}));
		} catch (err) {
			console.warn('[weekly-list] cache put failed', String(err));
		}
	}
	return records;
}
