/**
 * Database read for the #151 withdrawn-archive check (`archive-withdrawn.ts`).
 *
 * Reads only status / deleted_at / published_at of `ec_archives` rows whose slug or id equals the
 * requested path segment (the same match EmDash's loader uses). Never writes. Runs in
 * `src/pages/archives/[slug].astro`, after EmDash's runtime middleware, so `getDb()` is the
 * request-scoped client.
 */
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import type { ArchiveRowState } from './archive-withdrawn';

export async function lookupArchiveRowState(slugOrId: string): Promise<ArchiveRowState[]> {
	const db = await getDb();
	const result = await sql<ArchiveRowState>`
		SELECT status, deleted_at, published_at FROM ${sql.ref('ec_archives')}
		WHERE slug = ${slugOrId} OR id = ${slugOrId}
		LIMIT 5
	`.execute(db);
	return result.rows;
}
