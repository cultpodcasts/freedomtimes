/**
 * Which published posts belong on `/subjects/<slug>`.
 *
 * Matching is exact membership of the `subjects` JSON array (after trim),
 * compared case-insensitively. "France" does not match "Frances".
 *
 * Two different labels that fold to the same slug share one URL. The label
 * that sorts first in English (case-insensitive) is the page heading, and
 * only posts carrying that label are listed. The other label has no page.
 * Case variants of the same label ("France" / "france") are one label; the
 * heading prefers the variant that uses capitals.
 *
 * Pure: the database read is in `load.ts`. Rows are already published.
 */
import { subjectSlug } from './slug';

/**
 * Columns read from `ec_posts` for a subject page. `content` is not one of
 * them. `seo_no_index` comes from the SEO join, not this list.
 */
export const SUBJECT_POST_COLUMNS = ['id', 'slug', 'title', 'excerpt', 'subjects', 'published_at', 'updated_at'] as const;

export type SubjectPostRow = {
	id: string;
	slug: string;
	title: string;
	excerpt: string | null;
	subjects: string[];
	publishedAt: string | null;
	updatedAt: string | null;
	/** True when the post's SEO record sets `seo_no_index`. */
	noindex: boolean;
};

export type SubjectPage = {
	slug: string;
	/** Stored label, not the slug. */
	label: string;
	posts: SubjectPostRow[];
	/** At least one listed post is indexable. */
	indexable: boolean;
	/** Newest `updatedAt` among the listed posts (sitemap lastmod). */
	updatedAt: string | null;
};

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

function dateString(value: unknown): string | null {
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

function isNoindex(value: unknown): boolean {
	return value === 1 || value === true || value === '1';
}

/** One narrow `ec_posts` row (plus `seo_no_index`) to a subject-list row. Ignores any body column. */
export function mapSubjectPostRow(row: Record<string, unknown>): SubjectPostRow | null {
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
		updatedAt: dateString(row.updated_at ?? row.updatedAt),
		noindex: isNoindex(row.seo_no_index ?? row.noindex),
	};
}

function labelKey(label: string): string {
	return label.trim().toLowerCase();
}

/** Prefer a capitalised spelling when the only difference is case. */
function chooseDisplayLabel(labels: readonly string[]): string {
	return [...labels].sort((a, b) => {
		const aUp = a !== a.toLowerCase();
		const bUp = b !== b.toLowerCase();
		if (aUp !== bUp) return aUp ? -1 : 1;
		return a.localeCompare(b, 'en');
	})[0] ?? labels[0] ?? '';
}

function comparePosts(a: SubjectPostRow, b: SubjectPostRow): number {
	const published = (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
	if (published !== 0) return published;
	const updated = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
	if (updated !== 0) return updated;
	return b.id.localeCompare(a.id);
}

function newestUpdated(posts: readonly SubjectPostRow[]): string | null {
	let best: string | null = null;
	for (const post of posts) {
		const value = post.updatedAt ?? post.publishedAt;
		if (value && (!best || value > best)) best = value;
	}
	return best;
}

/**
 * One page per slug, sorted by slug. Posts on a page are newest first.
 * A post is listed once even if the label is repeated on it.
 */
export function buildSubjectDirectory(rows: readonly SubjectPostRow[]): SubjectPage[] {
	type Bucket = { labels: string[]; posts: SubjectPostRow[] };
	const bySlug = new Map<string, Map<string, Bucket>>();

	for (const row of rows) {
		const seenOnPost = new Set<string>();
		for (const raw of row.subjects) {
			const label = raw.trim();
			const slug = subjectSlug(label);
			if (!slug) continue;
			const key = labelKey(label);
			const once = `${slug}\0${key}`;
			if (seenOnPost.has(once)) continue;
			seenOnPost.add(once);
			let groups = bySlug.get(slug);
			if (!groups) {
				groups = new Map();
				bySlug.set(slug, groups);
			}
			let bucket = groups.get(key);
			if (!bucket) {
				bucket = { labels: [], posts: [] };
				groups.set(key, bucket);
			}
			bucket.labels.push(label);
			if (!bucket.posts.some((post) => post.id === row.id)) bucket.posts.push(row);
		}
	}

	const pages: SubjectPage[] = [];
	for (const [slug, groups] of bySlug) {
		const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'en'));
		const winner = keys[0];
		if (!winner) continue;
		const bucket = groups.get(winner);
		if (!bucket) continue;
		const posts = [...bucket.posts].sort(comparePosts);
		pages.push({
			slug,
			label: chooseDisplayLabel(bucket.labels),
			posts,
			indexable: posts.some((post) => !post.noindex),
			updatedAt: newestUpdated(posts),
		});
	}
	pages.sort((a, b) => a.slug.localeCompare(b.slug, 'en'));
	return pages;
}

export function subjectPageForSlug(rows: readonly SubjectPostRow[], slug: string): SubjectPage | null {
	return buildSubjectDirectory(rows).find((page) => page.slug === slug) ?? null;
}

/** Sitemap entries: indexable subjects only, slug order. */
export function indexableSubjectSitemapEntries(rows: readonly SubjectPostRow[]): { slug: string; updatedAt: string | null }[] {
	return buildSubjectDirectory(rows)
		.filter((page) => page.indexable)
		.map((page) => ({ slug: page.slug, updatedAt: page.updatedAt }));
}
