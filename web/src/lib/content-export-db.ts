/**
 * Binds the pure content export (src/lib/content-export.ts) to EmDash's database: whatever
 * `getDb()` returns for this Worker (Cloudflare D1 via the EMDASH binding when
 * FT_CONTENT_BACKEND=d1, the request-scoped libsql client when turso). Read-only: the export only
 * reads `sqlite_master` and runs `SELECT *` per table.
 */
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import { readOptionalEnv } from './auth';
import type { ContentExportQuery, ContentExportRow } from './content-export';

export function currentContentBackend(): string {
	return readOptionalEnv('FT_CONTENT_BACKEND').trim().toLowerCase() || 'turso';
}

/** Resolve the DB once, up front: the stream keeps pulling after the route handler returns. */
export async function createContentExportQuery(): Promise<ContentExportQuery> {
	const db = await getDb();
	return async (text: string) => {
		const result = await sql.raw<ContentExportRow>(text).execute(db);
		return result.rows;
	};
}