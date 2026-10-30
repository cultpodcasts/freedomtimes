/**
 * Lightweight homepage post list.
 *
 * `getEmDashCollection('posts', …)` runs `SELECT *` (plus byline/taxonomy JSON
 * hydration) on `ec_posts`, which pulls every post's full Portable Text body —
 * ~1.6 MB of JSON for ~32 posts on production — only for the homepage to read
 * slug, title, excerpt, subjects, featured image and dates.
 *
 * This module selects just those columns with the same WHERE / ORDER BY / LIMIT
 * semantics as EmDash's collection loader (emdash 1.4.x `loader.ts`):
 *   WHERE deleted_at IS NULL AND status = 'published'
 *   ORDER BY published_at DESC, updated_at DESC, id DESC
 * and maps rows to the same `{ id, slug, data }` shape the loader returns
 * (dates as `Date`, JSON columns parsed, local media values normalised), so
 * the homepage's existing entry → Story mapping is unchanged.
 *
 * Edit mode / preview requests (editors seeing draft revisions) keep using
 * `getEmDashCollection`, which overlays draft revisions; so does any failure
 * of the light query (logged, never thrown).
 */
import { getEmDashCollection, getRequestContext } from 'emdash';
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import { HOMEPAGE_POST_COLUMNS, mapHomepageRow, type HomepageEntry } from './homepage-entries-map';

export type { HomepageEntry };

/**
 * Show all published posts (newest first). A hard cap of 12 was dropping older features
 * (PBCC, Ahmadi, intro) once weekly roundups filled the slot.
 */
export const HOMEPAGE_POST_LIMIT = 100;

/**
 * Published posts for the homepage, newest first. Same filter/order/limit as
 * `getEmDashCollection('posts', { status: 'published', limit, orderBy: { published_at: 'desc', updated_at: 'desc' } })`.
 */
export async function loadHomepageEntries(limit = HOMEPAGE_POST_LIMIT): Promise<HomepageEntry[]> {
  const ctx = getRequestContext();
  const needsDrafts = Boolean(ctx?.editMode) || ctx?.preview?.collection === 'posts';
  if (!needsDrafts) {
    try {
      const db = await getDb();
      const cols = sql.join(HOMEPAGE_POST_COLUMNS.map((c) => sql.ref(c)));
      const result = await sql<Record<string, unknown>>`
        SELECT ${cols} FROM ${sql.ref('ec_posts')}
        WHERE deleted_at IS NULL AND status = ${'published'}
        ORDER BY ${sql.ref('published_at')} DESC, ${sql.ref('updated_at')} DESC, ${sql.ref('id')} DESC
        LIMIT ${limit}
      `.execute(db);
      return result.rows.map(mapHomepageRow);
    } catch (error) {
      console.warn('[ft-homepage] light posts query failed; falling back to getEmDashCollection', error);
    }
  }
  const { entries, error } = await getEmDashCollection('posts', {
    status: 'published',
    limit,
    orderBy: { published_at: 'desc', updated_at: 'desc' },
  });
  if (error) throw error;
  return entries as unknown as HomepageEntry[];
}
