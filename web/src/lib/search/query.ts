/**
 * Reader search over published posts. Matching is EmDash FTS5 (`search()` in
 * `post-search.ts`). This module only normalises the request and turns the
 * narrow display rows into the order FTS returned.
 *
 * Fields the posts index should cover. `title` and `content` already are.
 * `excerpt`, `lede`, and `subjects` are marked searchable in `.emdash/seed.json`.
 * A database that was created before that flag was stored still omits them
 * until the manual rebuild in `web/docs/SEARCH.md`.
 */
export const POST_SEARCH_FIELDS = ['title', 'content', 'excerpt', 'lede', 'subjects'] as const;

export const SEARCH_QUERY_MAX_LENGTH = 200;
export const SEARCH_PAGE_SIZE = 20;

/** Columns hydrated after FTS. The body is not one of them. */
export const SEARCH_DISPLAY_COLUMNS = ['id', 'slug', 'title', 'excerpt', 'subjects', 'published_at'] as const;

export type NormalizedSearchQuery =
	| { ok: true; query: string }
	| { ok: false; reason: 'empty' | 'too_long' };

/** `subjects` is a JSON string array on the post row. */
export function parseSubjects(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item.length > 0);
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return [];
		if (trimmed.startsWith('[')) {
			try {
				return parseSubjects(JSON.parse(trimmed) as unknown);
			} catch {
				return [trimmed];
			}
		}
		return [trimmed];
	}
	return [];
}

export function normalizeSearchQuery(raw: string | null | undefined): NormalizedSearchQuery {
	const query = (raw ?? '').trim();
	if (!query) return { ok: false, reason: 'empty' };
	if (query.length > SEARCH_QUERY_MAX_LENGTH) return { ok: false, reason: 'too_long' };
	return { ok: true, query };
}

/** EmDash pagination cursors are base64 JSON. Reject anything else before it hits SQL. */
export function isSafeSearchCursor(cursor: string | null | undefined): cursor is string {
	if (!cursor) return false;
	return cursor.length <= 2048 && /^[A-Za-z0-9+/=_-]+$/.test(cursor);
}

export type SearchDisplayRow = {
	id: string;
	slug: string;
	title: string;
	excerpt: string | null;
	subjects: string[];
	publishedAt: string | null;
};

function dateString(value: unknown): string | null {
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

/** Ignores any `content` column present on the raw row. Drops a row with no id or slug. */
export function mapSearchDisplayRow(row: Record<string, unknown>): SearchDisplayRow | null {
	const id = typeof row.id === 'string' ? row.id : '';
	const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
	if (!id || !slug) return null;
	const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'Untitled post';
	const excerpt = typeof row.excerpt === 'string' && row.excerpt.trim() ? row.excerpt.trim() : null;
	return {
		id,
		slug,
		title,
		excerpt,
		subjects: parseSubjects(row.subjects),
		publishedAt: dateString(row.published_at ?? row.publishedAt),
	};
}

/**
 * Keep FTS rank order. A ranked id with no published display row is dropped
 * (draft, deleted, or missing slug). Rows FTS did not return are dropped.
 */
export function orderPublishedHits(rankedIds: readonly string[], rows: readonly SearchDisplayRow[]): SearchDisplayRow[] {
	const byId = new Map<string, SearchDisplayRow>();
	for (const row of rows) {
		if (!byId.has(row.id)) byId.set(row.id, row);
	}
	const hits: SearchDisplayRow[] = [];
	const seen = new Set<string>();
	for (const id of rankedIds) {
		if (seen.has(id)) continue;
		const row = byId.get(id);
		if (!row) continue;
		seen.add(id);
		hits.push(row);
	}
	return hits;
}
