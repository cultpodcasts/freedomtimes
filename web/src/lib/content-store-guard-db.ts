/**
 * Database probe for the content-store guard (#128, see `content-store-guard.ts`).
 *
 * Runs in pages and in `src/middleware.ts` after EmDash's runtime middleware, so `getDb()` is the
 * request-scoped client. Never call it from `middleware.outer`. Reads only `sqlite_master` and one
 * row of `ec_posts`; never writes.
 */
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import {
	createContentStoreGuard,
	REQUIRED_CONTENT_TABLES,
	type ContentStoreProbeResult,
} from './content-store-guard';

async function probeContentStore(): Promise<ContentStoreProbeResult> {
	const db = await getDb();
	const tables = await sql<{ name: unknown }>`
		SELECT name FROM sqlite_master
		WHERE type = 'table'
		AND name IN (${sql.join(REQUIRED_CONTENT_TABLES.map((table) => sql`${table}`))})
	`.execute(db);
	const names = tables.rows.map((row) => String(row.name));
	if (!names.includes('ec_posts')) return { tables: names, hasPublishedPost: false };
	const posts = await sql<{ found: unknown }>`
		SELECT 1 AS found FROM ${sql.ref('ec_posts')}
		WHERE status = 'published' AND deleted_at IS NULL
		LIMIT 1
	`.execute(db);
	return { tables: names, hasPublishedPost: posts.rows.length > 0 };
}

/** One guard per isolate: a healthy probe is remembered, a failure never is. */
export const assertContentStoreReady = createContentStoreGuard(probeContentStore);
