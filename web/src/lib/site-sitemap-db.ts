/**
 * Database read for `/sitemap-site-pages.xml` (see `site-sitemap.ts`).
 *
 * Reads only slug / updated_at / SEO columns. Listed rows use the same WHERE as EmDash's own
 * sitemap query (`emdash` seo handler `indexableRows`): published, not deleted, non-empty slug,
 * not `seo_no_index`. Drafts and unpublished items are never listed, and draft revisions are
 * never overlaid (an editor in edit mode fetching the sitemap cannot put draft data in the cache).
 *
 * `/`'s lastmod uses the homepage's own set instead (`loadHomepageEntries()`: published, not
 * deleted, noindex posts included), so it moves when what `/` renders changes.
 *
 * Any query error throws, so the resilient wrapper serves the last-known-good copy (else 503)
 * instead of caching a sitemap with URLs missing.
 *
 * Runs in `src/middleware.ts`, after EmDash's runtime middleware, so `getDb()` is the
 * request-scoped client. Never call it from `middleware.outer`.
 */
import { getDb } from 'emdash/runtime';
import { sql } from 'kysely';

import { SITEMAP_PAGE_SLUGS, buildSiteSitemapUrls, renderUrlset, type SitemapContentRow } from './site-sitemap';

type Collection = 'posts' | 'pages' | 'archives';

/** Published, not-deleted rows: the filter `loadHomepageEntries()` uses for the homepage. */
function publishedFrom(collection: Collection) {
	return sql`
		FROM ${sql.ref(`ec_${collection}`)} c
		WHERE c.status = 'published'
		AND c.deleted_at IS NULL
	`;
}

/** Rows EmDash's sitemap would list: published, not deleted, slug set, not `seo_no_index`. */
function indexableFrom(collection: Collection) {
	return sql`
		FROM ${sql.ref(`ec_${collection}`)} c
		LEFT JOIN _emdash_seo s
			ON s.collection = ${collection}
			AND s.content_id = c.id
		WHERE c.status = 'published'
		AND c.deleted_at IS NULL
		AND c.slug IS NOT NULL
		AND TRIM(c.slug) <> ''
		AND (s.seo_no_index IS NULL OR s.seo_no_index = 0)
	`;
}

function rowString(value: unknown): string | null {
	if (typeof value === 'string') return value;
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	return null;
}

function toRows(rows: Record<string, unknown>[]): SitemapContentRow[] {
	return rows
		.map((row) => ({
			slug: rowString(row.slug) ?? '',
			updatedAt: rowString(row.updated_at),
			seoCanonical: rowString(row.seo_canonical),
		}))
		.filter((row) => row.slug.trim().length > 0);
}

export async function generateSiteSitemapXml(origin: string): Promise<string> {
	const db = await getDb();
	const posts = await sql<{ updated_at: unknown }>`
		SELECT MAX(c.updated_at) AS updated_at ${publishedFrom('posts')}
	`.execute(db);
	const pages = await sql<Record<string, unknown>>`
		SELECT c.slug, c.updated_at, s.seo_canonical ${indexableFrom('pages')}
		AND c.slug IN (${sql.join(SITEMAP_PAGE_SLUGS.map((slug) => sql`${slug}`))})
		ORDER BY c.id
	`.execute(db);
	const archives = await sql<Record<string, unknown>>`
		SELECT c.slug, c.updated_at, s.seo_canonical ${indexableFrom('archives')}
		ORDER BY c.id
	`.execute(db);
	const urls = buildSiteSitemapUrls(origin, {
		postsUpdatedAt: rowString(posts.rows[0]?.updated_at),
		pages: toRows(pages.rows),
		archives: toRows(archives.rows),
	});
	return renderUrlset(urls);
}

/** 200 XML response for the resilient wrapper (which adds caching headers and handles failures). */
export async function generateSiteSitemapResponse(origin: string): Promise<Response> {
	const xml = await generateSiteSitemapXml(origin);
	return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
