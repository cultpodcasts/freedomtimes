/**
 * Which published posts belong on `/subjects/<slug>`.
 *
 * Matching is exact membership of the `subjects` JSON array (after trim),
 * compared case-insensitively. "France" does not match "Frances".
 *
 * Two different labels that fold to the same slug share one URL. The page
 * lists every post carrying any of those labels, once per post id. The
 * heading is `chooseDisplayLabel` across every label on the slug. Case
 * variants of the same label ("France" / "france") are one label; the
 * heading prefers the variant that uses capitals.
 *
 * Pure: the database read is in `load.ts`. Rows are already published.
 * Title and excerpt are filled afterwards for the one page being rendered.
 */
import { subjectSlug } from './slug';

/**
 * Columns read while scanning every published post for the directory and
 * the sitemap. No title, excerpt, or body. `seo_no_index` comes from the
 * SEO join, not this list.
 */
export const SUBJECT_DIRECTORY_COLUMNS = ['id', 'slug', 'subjects', 'published_at', 'updated_at'] as const;

/** Columns loaded for the posts on one subject page, after that page is chosen. */
export const SUBJECT_DISPLAY_COLUMNS = ['id', 'title', 'excerpt'] as const;

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

/** Title and excerpt for one post, loaded only after the page's ids are known. */
export type SubjectDisplayFields = {
	id: string;
	title: string;
	excerpt: string | null;
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

/** Display row for one subject-page post. Ignores any body column. Drops a row with no id. */
export function mapSubjectDisplayRow(row: Record<string, unknown>): SubjectDisplayFields | null {
	const id = typeof row.id === 'string' ? row.id : '';
	if (!id) return null;
	const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : 'Untitled post';
	const excerpt = typeof row.excerpt === 'string' && row.excerpt.trim() ? row.excerpt.trim() : null;
	return { id, title, excerpt };
}

/** Replace title and excerpt on the posts whose ids came back from the display query. */
export function applySubjectDisplay(page: SubjectPage, displays: readonly SubjectDisplayFields[]): SubjectPage {
	const byId = new Map<string, SubjectDisplayFields>();
	for (const display of displays) {
		if (!byId.has(display.id)) byId.set(display.id, display);
	}
	return {
		...page,
		posts: page.posts.map((post) => {
			const display = byId.get(post.id);
			if (!display) return post;
			return { ...post, title: display.title, excerpt: display.excerpt };
		}),
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
 * One page per slug, sorted by slug. Every label that folds to the slug
 * contributes its posts. Posts on a page are newest first, and a post is
 * listed once even when it carries more than one of those labels.
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
		const labels: string[] = [];
		const postsById = new Map<string, SubjectPostRow>();
		for (const bucket of groups.values()) {
			labels.push(...bucket.labels);
			for (const post of bucket.posts) {
				if (!postsById.has(post.id)) postsById.set(post.id, post);
			}
		}
		if (labels.length === 0) continue;
		const posts = [...postsById.values()].sort(comparePosts);
		pages.push({
			slug,
			label: chooseDisplayLabel(labels),
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
