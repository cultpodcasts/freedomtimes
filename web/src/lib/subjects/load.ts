/**
 * Published posts for subject pages and the site sitemap.
 *
 * The directory scan reads every published post. Each query is a keyset page
 * on `id` (a bound page size, not a cap on the corpus) and selects only
 * id, slug, subjects, dates, and `seo_no_index`. A short page ends the scan.
 * Newest-first order is applied in `buildSubjectDirectory`, not in SQL.
 *
 * Title, excerpt, and featured image are a second query, and only for the
 * ids on the subject page being rendered. The body (`content`) is never
 * selected.
 *
 * `getDb()` follows `FT_CONTENT_BACKEND`, so this is D1 or Turso with the
 * Worker that is deployed.
 */
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import {
	SUBJECT_DIRECTORY_COLUMNS,
	SUBJECT_DISPLAY_COLUMNS,
	applySubjectDisplay,
	mapSubjectDisplayRow,
	mapSubjectPostRow,
	type SubjectPage,
	type SubjectPostRow,
} from './list';

/** Rows per directory query. The scan continues until a page comes back short. */
export const SUBJECT_DIRECTORY_PAGE_SIZE = 200;

/**
 * D1 allows 100 bound parameters on one query. The display query also binds
 * `status`, so each `IN` list stays under that.
 */
const SUBJECT_DISPLAY_ID_CHUNK = 80;

export type SubjectDirectoryPageReader = (
	afterId: string | null,
	limit: number,
) => Promise<readonly Record<string, unknown>[]>;

/**
 * Read every directory page. Stops only when a page is shorter than `pageSize`.
 * A full page whose last id does not advance throws, so a stuck cursor cannot
 * drop the tail of the corpus.
 */
export async function readSubjectDirectoryPages(
	readPage: SubjectDirectoryPageReader,
	pageSize = SUBJECT_DIRECTORY_PAGE_SIZE,
): Promise<SubjectPostRow[]> {
	if (!Number.isInteger(pageSize) || pageSize < 1) {
		throw new Error('subject directory page size must be a positive integer');
	}
	const rows: SubjectPostRow[] = [];
	let afterId: string | null = null;
	for (;;) {
		const batch = await readPage(afterId, pageSize);
		for (const raw of batch) {
			const mapped = mapSubjectPostRow(raw);
			if (mapped) rows.push(mapped);
		}
		if (batch.length < pageSize) return rows;
		const last = batch[batch.length - 1];
		const lastId = last && typeof last.id === 'string' ? last.id : '';
		if (!lastId || lastId === afterId) {
			throw new Error('subject directory page did not advance');
		}
		afterId = lastId;
	}
}

async function querySubjectDirectoryPage(afterId: string | null, limit: number): Promise<Record<string, unknown>[]> {
	const db = await getDb();
	const columns = sql.join(SUBJECT_DIRECTORY_COLUMNS.map((column) => sql.ref(`c.${column}`)));
	const result = await sql<Record<string, unknown>>`
		SELECT ${columns}, ${sql.ref('s.seo_no_index')} AS seo_no_index
		FROM ${sql.ref('ec_posts')} AS c
		LEFT JOIN ${sql.ref('_emdash_seo')} AS s
			ON ${sql.ref('s.collection')} = ${'posts'}
			AND ${sql.ref('s.content_id')} = ${sql.ref('c.id')}
		WHERE ${sql.ref('c.status')} = ${'published'}
		AND ${sql.ref('c.deleted_at')} IS NULL
		AND ${sql.ref('c.slug')} IS NOT NULL
		AND TRIM(${sql.ref('c.slug')}) <> ''
		AND (${afterId} IS NULL OR ${sql.ref('c.id')} > ${afterId})
		ORDER BY ${sql.ref('c.id')} ASC
		LIMIT ${limit}
	`.execute(db);
	return result.rows;
}

/** Every published post, directory columns only. Used by the subject page and the site sitemap. */
export async function loadPublishedSubjectRows(): Promise<SubjectPostRow[]> {
	return readSubjectDirectoryPages((afterId, limit) => querySubjectDirectoryPage(afterId, limit));
}

async function querySubjectDisplayRows(ids: readonly string[]): Promise<Record<string, unknown>[]> {
	const db = await getDb();
	const columns = sql.join(SUBJECT_DISPLAY_COLUMNS.map((column) => sql.ref(column)));
	const idList = sql.join(ids.map((id) => sql`${id}`));
	const result = await sql<Record<string, unknown>>`
		SELECT ${columns}
		FROM ${sql.ref('ec_posts')}
		WHERE ${sql.ref('deleted_at')} IS NULL
		AND ${sql.ref('status')} = ${'published'}
		AND ${sql.ref('id')} IN (${idList})
	`.execute(db);
	return result.rows;
}

/**
 * Title, excerpt, and featured image for the posts already chosen for one
 * subject page. Other published posts are not read. An empty page does not
 * query.
 */
export async function loadSubjectPagePosts(page: SubjectPage): Promise<SubjectPage> {
	const ids = page.posts.map((post) => post.id);
	if (ids.length === 0) return page;
	const displays = [];
	for (let offset = 0; offset < ids.length; offset += SUBJECT_DISPLAY_ID_CHUNK) {
		const chunk = ids.slice(offset, offset + SUBJECT_DISPLAY_ID_CHUNK);
		for (const row of await querySubjectDisplayRows(chunk)) {
			const mapped = mapSubjectDisplayRow(row);
			if (mapped) displays.push(mapped);
		}
	}
	return applySubjectDisplay(page, displays);
}
