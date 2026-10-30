/**
 * `/sitemap-site-pages.xml`: reader URLs EmDash's collection sitemaps leave out (#34).
 *
 * EmDash only builds `/sitemap-<collection>.xml` for collections with SEO and a URL
 * pattern, which on Freedom Times is `posts` alone. This child sitemap adds:
 * - `/` (newsroom; lastmod = newest update over published posts, the set the homepage lists,
 *   noindex posts included)
 * - `/about-us`, `/contact-us`, `/privacy-policy` (the `pages` entries in SITEMAP_PAGE_SLUGS)
 * - each `/archives/<slug>`, and `/archives` when at least one archive is listed (lastmod =
 *   newest update among the listed archives)
 *
 * Rows follow the same rule as EmDash's own sitemap query: published, not deleted, a
 * non-empty slug, and not `seo_no_index`. A row whose SEO canonical points at another URL is
 * left out, so every `<loc>` equals that page's `<link rel="canonical">`.
 *
 * Production only: the middleware serves this path and lists it in `/sitemap.xml` only when
 * the site is public (`isLockedSiteAccess()` false). Locked staging is untouched (EmDash
 * answers the path with its usual 404, and its sitemap index is passed through as before).
 *
 * Pure functions only (no Astro / emdash imports); the database read is in `site-sitemap-db.ts`.
 */
import { contentCanonicalPath, safeCanonical } from './seo/article-seo';

export const SITE_SITEMAP_PATH = '/sitemap-site-pages.xml';

/** `pages` entries listed at `/<slug>`. Other page slugs (e.g. staging's `homepage`) are never listed. */
export const SITEMAP_PAGE_SLUGS = ['about-us', 'contact-us', 'privacy-policy'] as const;

export const HOME_PATH = '/';
export const ARCHIVES_INDEX_PATH = '/archives';

/** One indexable row (already filtered: published, not deleted, slug set, not noindex). */
export interface SitemapContentRow {
	slug: string;
	updatedAt: string | null;
	/** `_emdash_seo.seo_canonical`, if any. */
	seoCanonical?: string | null;
}

export interface SiteSitemapInput {
	/**
	 * Newest `updated_at` over published, non-deleted posts (the homepage's set, noindex
	 * included, as in `loadHomepageEntries()`), or null.
	 */
	postsUpdatedAt: string | null;
	pages: SitemapContentRow[];
	archives: SitemapContentRow[];
}

export interface SiteSitemapUrl {
	loc: string;
	lastmod?: string;
}

const TZ_SUFFIX_RE = /([zZ]|[+-]\d{2}(:?\d{2})?)$/;

/**
 * W3C Datetime for `<lastmod>` (same normalisation as EmDash's sitemap: SQLite's
 * `YYYY-MM-DD HH:MM:SS` is read as UTC). Unparseable values return null (lastmod omitted).
 */
export function toW3CDate(value: string | null | undefined): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	let normalized = value.trim();
	if (normalized.includes(' ') && !normalized.includes('T')) normalized = normalized.replace(' ', 'T');
	if (!TZ_SUFFIX_RE.test(normalized)) normalized += 'Z';
	const parsed = Date.parse(normalized);
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function newest(values: (string | null | undefined)[]): string | null {
	let best: string | null = null;
	for (const value of values) {
		const iso = toW3CDate(value);
		if (iso && (!best || iso > best)) best = iso;
	}
	return best;
}

/** True when the row has no SEO canonical override, or the override is its own path. */
function isSelfCanonical(row: SitemapContentRow, ownPath: string, origin: string): boolean {
	const override = safeCanonical(row.seoCanonical, origin);
	if (!override) return true;
	try {
		const target = new URL(override, origin);
		return target.origin === new URL(origin).origin && target.pathname === new URL(ownPath, origin).pathname && !target.search;
	} catch {
		return false;
	}
}

/** Absolute URL built like Layout.astro builds `<link rel="canonical">`: `new URL(path, origin)`. */
function url(origin: string, path: string, lastmod: string | null): SiteSitemapUrl {
	const loc = new URL(path, `${origin}/`).toString();
	return lastmod ? { loc, lastmod } : { loc };
}

/** Sitemap URLs, in a stable order: `/`, pages (SITEMAP_PAGE_SLUGS order), `/archives`, archives by slug. */
export function buildSiteSitemapUrls(originInput: string, input: SiteSitemapInput): SiteSitemapUrl[] {
	const origin = originInput.replace(/\/+$/, '');
	const urls: SiteSitemapUrl[] = [url(origin, HOME_PATH, toW3CDate(input.postsUpdatedAt))];

	for (const slug of SITEMAP_PAGE_SLUGS) {
		const row = input.pages.find((candidate) => candidate.slug.trim() === slug);
		const path = contentCanonicalPath('pages', slug);
		if (row && isSelfCanonical(row, path, origin)) urls.push(url(origin, path, toW3CDate(row.updatedAt)));
	}

	const archives = input.archives
		.map((row) => ({ ...row, slug: row.slug.trim() }))
		.filter((row) => row.slug.length > 0 && !/[/?#\\]/.test(row.slug))
		.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	// Only self-canonical, deduped archives are listed; `/archives` is listed (and dated) from
	// exactly those rows, so every lastmod reflects a URL that is in this sitemap.
	const seen = new Set<string>();
	const listed: { path: string; updatedAt: string | null | undefined }[] = [];
	for (const row of archives) {
		const path = contentCanonicalPath('archives', row.slug);
		if (seen.has(path) || !isSelfCanonical(row, path, origin)) continue;
		seen.add(path);
		listed.push({ path, updatedAt: row.updatedAt });
	}
	if (listed.length > 0) {
		urls.push(url(origin, ARCHIVES_INDEX_PATH, newest(listed.map((row) => row.updatedAt))));
	}
	for (const row of listed) urls.push(url(origin, row.path, toW3CDate(row.updatedAt)));
	return urls;
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);
}

export function renderUrlset(urls: SiteSitemapUrl[]): string {
	const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
	for (const entry of urls) {
		lines.push('  <url>');
		lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
		if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
		lines.push('  </url>');
	}
	lines.push('</urlset>');
	return lines.join('\n');
}
