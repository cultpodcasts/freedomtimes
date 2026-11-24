/**
 * Published posts for subject pages and the site sitemap.
 *
 * Narrow columns only. The body (`content`) is not selected: a subject page
 * lists titles, excerpts, and chips, and reading the Portable Text column is
 * the cost the homepage query was written to avoid. Same filter as that
 * query (published, not deleted) plus a non-empty slug and the SEO noindex
 * flag. `getDb()` follows `FT_CONTENT_BACKEND`, so this is D1 or Turso with
 * the Worker that is deployed.
 */
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import { SUBJECT_POST_COLUMNS, mapSubjectPostRow, type SubjectPostRow } from './list';

/** Safety cap. The live corpus is far below this. */
export const SUBJECT_LIST_LIMIT = 500;

export async function loadPublishedSubjectRows(): Promise<SubjectPostRow[]> {
	const db = await getDb();
	const columns = sql.join(SUBJECT_POST_COLUMNS.map((column) => sql.raw(`c."${column}"`)));
	const result = await sql<Record<string, unknown>>`
		SELECT ${columns}, s.seo_no_index AS seo_no_index
		FROM ec_posts AS c
		LEFT JOIN _emdash_seo AS s
			ON s.collection = ${'posts'}
			AND s.content_id = c.id
		WHERE c.status = ${'published'}
		AND c.deleted_at IS NULL
		AND c.slug IS NOT NULL
		AND TRIM(c.slug) <> ''
		ORDER BY c.published_at DESC, c.updated_at DESC, c.id DESC
		LIMIT ${SUBJECT_LIST_LIMIT}
	`.execute(db);
	const rows: SubjectPostRow[] = [];
	for (const row of result.rows) {
		const mapped = mapSubjectPostRow(row);
		if (mapped) rows.push(mapped);
	}
	return rows;
}
