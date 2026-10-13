/**
 * Article SEO helpers: meta resolution from the EmDash SEO record (with
 * fallbacks), discrete structured-data fields on `posts`, and schema.org
 * JSON-LD (NewsArticle + BreadcrumbList).
 *
 * Pure functions only (no Astro / Worker imports) so they can be unit tested
 * with `tsx --test scripts/test-article-seo.mts`.
 *
 * Every optional field falls back to the value used before these fields
 * existed, so an entry with nothing filled in renders exactly as before
 * (apart from the og:title date suffix, which is intentionally gone).
 */

export const PUBLISHER_LOGO_PATH = '/social/avatar-ft-400.png';
export const PUBLISHER_LOGO_SIZE = 400;
export const WEEKLY_SUMMARY_SLUG_PREFIX = 'weekly-summary-';
export const WEEKLY_SUMMARIES_HUB_PATH = '/weekly-summaries';
export const WEEKLY_SUMMARIES_HUB_TITLE = 'Weekly summaries';

export type ArticlePerson = { name: string; url?: string };
export type ArticleOrganisation = { name: string; type?: string; url?: string };
export type ArticlePlace = { name: string };

/** Discrete, optional per-article fields (posts collection; AI pipeline populates them). */
export interface ArticleStructuredFields {
	lede: string | null;
	coverageStart: string | null;
	coverageEnd: string | null;
	people: ArticlePerson[];
	organisations: ArticleOrganisation[];
	places: ArticlePlace[];
	socialTitle: string | null;
}

function str(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function httpUrl(value: unknown): string | undefined {
	const s = str(value);
	if (!s) return undefined;
	try {
		const u = new URL(s);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** JSON fields may arrive parsed or as a JSON string. */
function list(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value === 'string' && value.trim().startsWith('[')) {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

function named<T extends { name: string }>(raw: unknown[], map: (rec: Record<string, unknown>, name: string) => T): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of raw) {
		const rec: Record<string, unknown> | null =
			typeof item === 'string'
				? { name: item }
				: item && typeof item === 'object' && !Array.isArray(item)
					? (item as Record<string, unknown>)
					: null;
		const name = rec ? str(rec.name) : null;
		if (!rec || !name) continue;
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(map(rec, name));
	}
	return out;
}

export const EDITORIAL_TIME_ZONE = 'Europe/London';

function londonDate(d: Date): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat('en-CA', { timeZone: EDITORIAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Calendar date (YYYY-MM-DD) in Europe/London from a date/datetime field, or null.
 * Date-only values pass through; datetimes (e.g. `2026-10-03T23:00:00Z`, a BST
 * midnight stored as UTC) are converted to the London date so they are not a day early.
 */
export function readIsoDate(value: unknown): string | null {
	const s = str(value);
	if (!s) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
	const d = new Date(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
	if (Number.isFinite(d.getTime())) return londonDate(d);
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
	return m ? m[1] : null;
}

function withoutUndefined<T extends Record<string, unknown>>(rec: T): T {
	return Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined)) as T;
}

export function readArticleStructuredFields(data: Record<string, unknown>): ArticleStructuredFields {
	return {
		lede: str(data.lede),
		coverageStart: readIsoDate(data.coverage_start),
		coverageEnd: readIsoDate(data.coverage_end),
		people: named(list(data.people), (rec, name) => withoutUndefined({ name, url: httpUrl(rec.url) })),
		organisations: named(list(data.organisations), (rec, name) =>
			withoutUndefined({ name, type: str(rec.type) ?? undefined, url: httpUrl(rec.url) })),
		places: named(list(data.places), (_rec, name) => ({ name })),
		socialTitle: str(data.social_title),
	};
}

/**
 * A CMS canonical override is accepted only when it stays on this site:
 * a root-relative path (not protocol-relative `//host`), or an absolute URL with
 * the same host as `siteOrigin` and not downgrading https → http.
 * Anything else returns undefined (caller falls back to the page's own path).
 */
export function safeCanonical(value: unknown, siteOrigin: string): string | undefined {
	const s = str(value);
	if (!s) return undefined;
	if (s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\')) {
		try {
			const u = new URL(s, siteOrigin);
			return u.origin === new URL(siteOrigin).origin ? `${u.pathname}${u.search}` : undefined;
		} catch {
			return undefined;
		}
	}
	try {
		const site = new URL(siteOrigin);
		const u = new URL(s);
		if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
		if (u.hostname.toLowerCase() !== site.hostname.toLowerCase()) return undefined;
		if (site.protocol === 'https:' && u.protocol !== 'https:') return undefined;
		if (u.username || u.password) return undefined;
		return u.toString();
	} catch {
		return undefined;
	}
}

export interface ResolvedArticleMeta {
	/** Headline part of `<title>` (Layout appends ` | site name`). */
	title: string;
	/** og:title / twitter:title — never carries a date suffix. */
	socialTitle: string;
	description: string;
	/** Path or absolute URL. */
	canonical: string;
	noindex: boolean;
}

/**
 * Resolve meta from the EmDash SEO record with fallbacks:
 * - seo.title → <title> and og:title (fallback: entry title)
 * - social_title → og:title only (fallback: seo.title, then entry title)
 * - seo.description → meta/og/twitter description (fallback: first excerpt paragraph)
 * - seo.canonical → canonical (fallback: own path)
 * - seo.noIndex → robots noindex (fallback: false)
 */
export function resolveArticleMeta(input: {
	title: string;
	seo: Record<string, unknown> | null;
	summaryParagraphs: string[];
	canonicalPath: string;
	/** Site origin (e.g. `https://freedomtimes.news`); canonical overrides must be same-host. */
	siteOrigin: string;
	fields: Pick<ArticleStructuredFields, 'socialTitle'>;
	fallbackDescription: string;
}): ResolvedArticleMeta {
	const seo = input.seo ?? {};
	const seoTitle = str(seo.title);
	const title = seoTitle ?? input.title;
	const socialTitle = input.fields.socialTitle ?? title;
	const description = str(seo.description) ?? input.summaryParagraphs[0] ?? input.fallbackDescription;
	const canonical = safeCanonical(seo.canonical, input.siteOrigin) ?? input.canonicalPath;
	const noIndexRaw = seo.noIndex ?? seo.noindex ?? seo.no_index;
	const noindex = noIndexRaw === true || noIndexRaw === 1 || noIndexRaw === 'true' || noIndexRaw === '1';
	return { title, socialTitle, description, canonical, noindex };
}

export interface ArticleJsonLdInput {
	origin: string;
	canonicalUrl: string;
	headline: string;
	description: string | null;
	fields: ArticleStructuredFields;
	publishedAt: string | null;
	updatedAt: string | null;
	bylineName: string | null;
	/** Byline record's profile / website URL, when set. */
	bylineUrl?: string | null;
	imageUrls: string[];
	subjects: string[];
	siteName: string;
	section?: { name: string; url: string } | null;
}

function absolute(origin: string, pathOrUrl: string): string {
	return new URL(pathOrUrl, origin).toString();
}

function isoDateTime(value: string | null): string | undefined {
	if (!value) return undefined;
	const d = new Date(value);
	return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

const ORGANISATION_TYPE_MAP: Array<[RegExp, string]> = [
	[/\b(court|tribunal|judiciary)\b/, 'GovernmentOrganization'],
	[/\b(government|ministry|council|police|regulator|parliament|agency|prosecutor|public body)\b/, 'GovernmentOrganization'],
	[/\b(cult|church|religio\w*|sect|faith|mosque|temple|monastery|ministry of faith|new religious movement|nrm)\b/, 'ReligiousOrganization'],
	[/\b(charity|ngo|non-?profit|foundation|association|support group)\b/, 'NGO'],
	[/\b(school|university|college|academy)\b/, 'EducationalOrganization'],
	[/\b(news|media|newspaper|broadcaster|publisher)\b/, 'NewsMediaOrganization'],
	[/\b(company|business|corporation|firm|brand)\b/, 'Corporation'],
];

/** Map a free-text organisation type to a schema.org Organization subtype; unknown → `Organization`. */
export function organisationSchemaType(type: string | undefined | null): string {
	const t = (type ?? '').trim().toLowerCase();
	if (!t) return 'Organization';
	for (const [re, schemaType] of ORGANISATION_TYPE_MAP) if (re.test(t)) return schemaType;
	return 'Organization';
}

/** schema.org NewsArticle. Empty properties are omitted. */
export function buildNewsArticleJsonLd(input: ArticleJsonLdInput): Record<string, unknown> {
	const { fields } = input;
	const publisher = {
		'@type': 'NewsMediaOrganization',
		name: input.siteName,
		url: absolute(input.origin, '/'),
		logo: {
			'@type': 'ImageObject',
			url: absolute(input.origin, PUBLISHER_LOGO_PATH),
			width: PUBLISHER_LOGO_SIZE,
			height: PUBLISHER_LOGO_SIZE,
		},
	};
	const author = input.bylineName
		? (input.bylineName.trim().toLowerCase() === input.siteName.trim().toLowerCase()
			? { '@type': 'Organization', name: input.bylineName, url: absolute(input.origin, '/') }
			: withoutUndefined({ '@type': 'Person', name: input.bylineName, url: httpUrl(input.bylineUrl) }))
		: undefined;

	const about = [
		...fields.organisations.map((o) => withoutUndefined({
			'@type': organisationSchemaType(o.type),
			name: o.name,
			url: o.url,
		})),
	];
	const mentions = fields.people.map((p) => withoutUndefined({ '@type': 'Person', name: p.name, url: p.url }));
	const spatial = fields.places.map((p) => ({ '@type': 'Place', name: p.name }));
	const temporalCoverage = fields.coverageStart
		? (fields.coverageEnd ? `${fields.coverageStart}/${fields.coverageEnd}` : fields.coverageStart)
		: undefined;
	const images = [...new Set(input.imageUrls.filter((u) => u && u.length > 0).map((u) => absolute(input.origin, u)))];
	const description = fields.lede ?? input.description ?? undefined;

	const ld: Record<string, unknown> = {
		'@context': 'https://schema.org',
		'@type': 'NewsArticle',
		mainEntityOfPage: { '@type': 'WebPage', '@id': input.canonicalUrl },
		url: input.canonicalUrl,
		headline: input.headline.length > 110 ? `${input.headline.slice(0, 109).trimEnd()}…` : input.headline,
		description,
		image: images.length > 0 ? images : undefined,
		datePublished: isoDateTime(input.publishedAt),
		dateModified: isoDateTime(input.updatedAt) ?? isoDateTime(input.publishedAt),
		author,
		publisher,
		articleSection: input.section?.name,
		keywords: input.subjects.length > 0 ? input.subjects.join(', ') : undefined,
		about: about.length > 0 ? about : undefined,
		mentions: mentions.length > 0 ? mentions : undefined,
		spatialCoverage: spatial.length > 0 ? spatial : undefined,
		temporalCoverage,
		isAccessibleForFree: true,
		inLanguage: 'en-GB',
	};
	return withoutUndefined(ld);
}

export function buildBreadcrumbJsonLd(input: {
	origin: string;
	siteName: string;
	trail: Array<{ name: string; url: string }>;
}): Record<string, unknown> {
	const items = [{ name: input.siteName, url: '/' }, ...input.trail];
	return {
		'@context': 'https://schema.org',
		'@type': 'BreadcrumbList',
		itemListElement: items.map((item, index) => ({
			'@type': 'ListItem',
			position: index + 1,
			name: item.name,
			item: absolute(input.origin, item.url),
		})),
	};
}

/** Serialize for `<script type="application/ld+json">` (no `</script>` breakout). */
export function serializeJsonLd(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

export function isWeeklySummarySlug(slug: string | null | undefined): boolean {
	return typeof slug === 'string' && slug.startsWith(WEEKLY_SUMMARY_SLUG_PREFIX);
}

export interface WeeklyListItem {
	slug: string;
	title: string;
	/** Sort key: coverage_start, else publishedAt. */
	sortDate: string;
}

/** Oldest → newest. */
export function sortWeeklies(items: WeeklyListItem[]): WeeklyListItem[] {
	return [...items].sort((a, b) => (a.sortDate < b.sortDate ? -1 : a.sortDate > b.sortDate ? 1 : a.slug.localeCompare(b.slug)));
}

export function findWeeklyNeighbours(
	items: WeeklyListItem[],
	slug: string,
): { previous: WeeklyListItem | null; next: WeeklyListItem | null } {
	const sorted = sortWeeklies(items);
	const index = sorted.findIndex((item) => item.slug === slug);
	if (index < 0) return { previous: null, next: null };
	return {
		previous: index > 0 ? sorted[index - 1] : null,
		next: index < sorted.length - 1 ? sorted[index + 1] : null,
	};
}

/** Reader-site pages that have historically been linked under `/posts/`. */
export const MISROUTED_PAGE_SLUGS = ['about-us', 'contact-us', 'privacy-policy', 'submit-a-tip'] as const;

/**
 * Canonical redirect for reader URLs (301), or null:
 * - `/posts/<slug>/` → `/posts/<slug>` (trailing slash)
 * - `/weekly-summaries/` → `/weekly-summaries`
 * - `/posts/about-us` etc. → `/about-us`
 * Query string is preserved.
 */
export function resolveCanonicalRedirect(pathname: string, search = ''): string | null {
	let target: string | null = null;
	const postMatch = /^\/posts\/([^/]+)\/+$/.exec(pathname);
	if (postMatch) target = `/posts/${postMatch[1]}`;
	if (/^\/weekly-summaries\/+$/.test(pathname)) target = WEEKLY_SUMMARIES_HUB_PATH;
	const slug = /^\/posts\/([^/]+)$/.exec(target ?? pathname)?.[1];
	if (slug && (MISROUTED_PAGE_SLUGS as readonly string[]).includes(slug)) target = `/${slug}`;
	return target ? `${target}${search}` : null;
}
