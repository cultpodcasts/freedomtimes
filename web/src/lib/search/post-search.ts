/**
 * Published-post search. EmDash `search()` reads the FTS5 index (title and
 * body today; excerpt, lede, and subjects after the rebuild in
 * `web/docs/SEARCH.md`). A second query loads display fields for those ids
 * only, published and not deleted, without the body column.
 *
 * `getDb()` / `search()` follow `FT_CONTENT_BACKEND`, so D1 and Turso share
 * this path. Status is always `published`. Callers do not pass a status.
 */
import { InvalidCursorError, SearchUnavailableError, search } from 'emdash';
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import {
	SEARCH_DISPLAY_COLUMNS,
	SEARCH_PAGE_SIZE,
	mapSearchDisplayRow,
	orderPublishedHits,
	type SearchDisplayRow,
} from './query';

export type PublishedSearchResult = {
	hits: SearchDisplayRow[];
	nextCursor?: string;
	unavailable?: boolean;
	invalidCursor?: boolean;
};

export async function searchPublishedPosts(query: string, cursor?: string): Promise<PublishedSearchResult> {
	let rankedIds: string[];
	let nextCursor: string | undefined;
	try {
		const result = await search(query, {
			collections: ['posts'],
			status: 'published',
			limit: SEARCH_PAGE_SIZE,
			cursor,
		});
		rankedIds = [];
		const seen = new Set<string>();
		for (const item of result.items) {
			if (item.collection !== 'posts' || !item.id || seen.has(item.id)) continue;
			seen.add(item.id);
			rankedIds.push(item.id);
		}
		nextCursor = result.nextCursor;
	} catch (error) {
		if (error instanceof SearchUnavailableError) return { hits: [], unavailable: true };
		if (error instanceof InvalidCursorError) return { hits: [], invalidCursor: true };
		throw error;
	}

	if (rankedIds.length === 0) return { hits: [], nextCursor };

	const db = await getDb();
	const columns = sql.join(SEARCH_DISPLAY_COLUMNS.map((column) => sql.raw(`"${column}"`)));
	const ids = sql.join(rankedIds.map((id) => sql`${id}`));
	const loaded = await sql<Record<string, unknown>>`
		SELECT ${columns}
		FROM ec_posts
		WHERE deleted_at IS NULL
		AND status = ${'published'}
		AND id IN (${ids})
	`.execute(db);
	const rows: SearchDisplayRow[] = [];
	for (const row of loaded.rows) {
		const mapped = mapSearchDisplayRow(row);
		if (mapped) rows.push(mapped);
	}
	return { hits: orderPublishedHits(rankedIds, rows), nextCursor };
}
