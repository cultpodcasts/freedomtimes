import { createClient } from '@libsql/client/web';

import { readOptionalEnv } from '../auth';
import { resolveEntryBody } from './entryBody';
import { readImageCaption } from './imageCaption';
import {
	readEmDashPublishedOrCreatedAt,
	readEmDashUpdatedAt,
} from './emdashTimestamps';

export type SlideImage = { src: string; pageNumber: number | null };

export type SubjectChip = {
	label: string;
	style: string;
};

export type ContentEntryViewModel = {
	title: string;
	summaryParagraphs: string[];
	portableContent: unknown[] | null;
	textContent: string | null;
	featuredImageSrc: string | null;
	featuredImageAlt: string;
	featuredImageCaption: string | null;
	socialImageSrc: string | null;
	volumeNumber: number | null;
	regionalVariant: 'Lancaster' | 'Newcastle' | 'Nottingham' | null;
	pageImages: SlideImage[];
	slidePageNumbers: number[];
	slidePageTotal: number;
	pdfLink: string | null;
	subjects: string[];
	subjectChips: SubjectChip[];
	issueDate: string | null;
	publishedAt: string | null;
	updatedAt: string | null;
	primaryByline: string | null;
};

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string') {
		const parsed = Number.parseInt(value.trim(), 10);
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function tryParseJsonString(value: string): unknown {
	const trimmed = value.trim();
	if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
		return null;
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}

/**
 * Public file URLs are only `/_emdash/api/media/file/<storageKey>` where `storageKey` is the
 * R2 object name (EmDash uses e.g. `<ulid>.png`). Media row `id` is different and returns 404 if
 * used as `key` (see emdash `addUrlToMedia` / `storage.download(key)`).
 */
function normalizeToPublicMediaFilePath(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.startsWith('/_emdash/api/media/file/')) {
		return trimmed;
	}
	if (trimmed.startsWith('/')) {
		return null;
	}
	if (trimmed.includes('://')) {
		try {
			const pathname = new URL(trimmed).pathname;
			return pathname.startsWith('/_emdash/api/media/file/') ? pathname : null;
		} catch {
			return null;
		}
	}
	// Storage keys in this project include a file extension; bare ULIDs are media ids, not keys.
	if (/\.[a-z0-9]{2,5}$/i.test(trimmed) && !trimmed.includes('/')) {
		return `/_emdash/api/media/file/${trimmed}`;
	}
	return null;
}

function readFeaturedImageSrc(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return null;
		}
		const parsed = tryParseJsonString(trimmed);
		if (parsed && typeof parsed === 'object' && parsed !== null) {
			return readFeaturedImageSrc(parsed);
		}
		return normalizeToPublicMediaFilePath(trimmed);
	}

	if (value && typeof value === 'object') {
		const candidate = value as Record<string, unknown>;
		const meta =
			candidate.meta && typeof candidate.meta === 'object'
				? (candidate.meta as Record<string, unknown>)
				: null;
		const storageKey =
			readString(meta?.storageKey)
			?? readString(meta?.storage_key)
			?? readString(candidate.storageKey)
			?? readString(candidate.storage_key);
		if (storageKey) {
			return `/_emdash/api/media/file/${storageKey}`;
		}

		const src = readString(candidate.src) ?? readString(candidate.url);
		if (src) {
			return normalizeToPublicMediaFilePath(src);
		}

		return null;
	}

	return null;
}

function readMediaFileUrl(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return null;
		}

		const parsed = tryParseJsonString(trimmed);
		if (parsed && parsed !== value) {
			return readMediaFileUrl(parsed);
		}

		return trimmed;
	}

	if (value && typeof value === 'object') {
		const candidate = value as Record<string, unknown>;
		const url =
			readString(candidate.url) ??
			readString(candidate.src) ??
			readString(candidate.file) ??
			readString(candidate.path) ??
			readString(candidate.href);
		if (url) {
			return url;
		}

		const nestedValue =
			readString(candidate.value) ??
			readString(candidate.filename) ??
			readString(candidate.key);
		if (nestedValue) {
			return nestedValue;
		}

		const meta =
			candidate.meta && typeof candidate.meta === 'object'
				? (candidate.meta as Record<string, unknown>)
				: null;
		const storageKey =
			readString(meta?.storageKey)
			?? readString(meta?.storage_key)
			?? readString(candidate.storageKey)
			?? readString(candidate.storage_key);
		if (storageKey) {
			return `/_emdash/api/media/file/${storageKey}`;
		}

		const mediaId = readString(candidate.id);
		if (mediaId && /\.[a-z0-9]{2,5}$/i.test(mediaId)) {
			return `/_emdash/api/media/file/${mediaId}`;
		}

		const mediaRef = readString(candidate._ref);
		if (mediaRef && /\.[a-z0-9]{2,5}$/i.test(mediaRef)) {
			return `/_emdash/api/media/file/${mediaRef}`;
		}
	}

	return null;
}

function normalizeEmdashMediaFileUrl(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	if (trimmed.startsWith('/_emdash/api/media/file/')) {
		return trimmed;
	}

	if (trimmed.startsWith('/')) {
		return null;
	}

	try {
		const parsed = new URL(trimmed);
		if (parsed.pathname.startsWith('/_emdash/api/media/file/')) {
			return parsed.pathname;
		}
	} catch {
		return null;
	}

	return null;
}

function normalizeImageUrl(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith('/')) return trimmed;

	try {
		const parsed = new URL(trimmed);
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return null;
	}
}

function extractPageNumber(value: unknown): number | null {
	const parse = (candidate: string | null): number | null => {
		if (!candidate) return null;
		const match = candidate.match(/--page-(\d+)\.(?:png|jpg|jpeg|webp)$/i);
		if (!match) return null;
		const parsed = Number.parseInt(match[1], 10);
		return Number.isFinite(parsed) ? parsed : null;
	};

	if (typeof value === 'string') {
		return parse(value.trim());
	}

	if (value && typeof value === 'object') {
		const candidate = value as Record<string, unknown>;
		return (
			parse(readString(candidate.filename))
			?? parse(readString(candidate.name))
			?? parse(readString(candidate.src))
			?? parse(readString(candidate.url))
		);
	}

	return null;
}

function coerceImageList(value: unknown): SlideImage[] {
	const add = (collector: SlideImage[], candidate: unknown) => {
		const fromMedia = readMediaFileUrl(candidate);
		const fromString = readString(candidate);
		const resolved =
			(fromMedia && normalizeImageUrl(fromMedia))
			?? (fromString && normalizeImageUrl(fromString))
			?? null;
		if (resolved) {
			collector.push({ src: resolved, pageNumber: extractPageNumber(candidate) });
		}
	};

	if (Array.isArray(value)) {
		const images: SlideImage[] = [];
		for (const item of value) add(images, item);
		return images;
	}

	if (typeof value === 'string') {
		const parsed = tryParseJsonString(value);
		if (Array.isArray(parsed)) {
			const images: SlideImage[] = [];
			for (const item of parsed) add(images, item);
			return images;
		}
		const single = normalizeImageUrl(value);
		return single ? [{ src: single, pageNumber: extractPageNumber(value) }] : [];
	}

	return [];
}

function readSubjects(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.map((item) => (typeof item === 'string' ? item.trim() : ''))
			.filter((item) => item.length > 0);
	}

	if (typeof value === 'string') {
		const parsed = tryParseJsonString(value);
		if (Array.isArray(parsed)) {
			return parsed
				.map((item) => (typeof item === 'string' ? item.trim() : ''))
				.filter((item) => item.length > 0);
		}

		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}

	return [];
}

function hashString(input: string): number {
	let hash = 2166136261;
	for (const char of input) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function subjectColorTokens(subject: string): { bg: string; border: string; text: string } {
	const hash = hashString(subject.toLowerCase().trim());
	const hue = hash % 360;
	const saturation = 62 + (hash % 14);
	const lightness = 90 - (hash % 8);
	const borderLightness = 46 - (hash % 8);
	const textLightness = 28 - (hash % 6);
	return {
		bg: `hsl(${hue} ${saturation}% ${lightness}%)`,
		border: `hsl(${hue} ${Math.max(45, saturation - 12)}% ${borderLightness}%)`,
		text: `hsl(${hue} ${Math.max(40, saturation - 18)}% ${textLightness}%)`,
	};
}

function readPrimaryByline(entryMeta: Record<string, unknown>, data: Record<string, unknown>): string | null {
	const direct = (
		(entryMeta.byline && typeof entryMeta.byline === 'object' ? entryMeta.byline : null)
		?? (data.byline && typeof data.byline === 'object' ? data.byline : null)
	) as Record<string, unknown> | null;
	const bylinesArray = (
		(Array.isArray(entryMeta.bylines) ? entryMeta.bylines : null)
		?? (Array.isArray(data.bylines) ? data.bylines : null)
	) as unknown[] | null;
	const fromArray = bylinesArray && bylinesArray.length > 0
		? (bylinesArray[0] as Record<string, unknown>)
		: null;
	const bylineRecord =
		direct
		?? (
			fromArray && fromArray.byline && typeof fromArray.byline === 'object'
				? (fromArray.byline as Record<string, unknown>)
				: null
		);
	return (
		(bylineRecord ? readString(bylineRecord.displayName) : null)
		?? (fromArray ? readString(fromArray.displayName) : null)
		?? readString(data.author)
		?? readString(data.bylineName)
	);
}

/**
 * EmDash exposes SEO as **`entry.seo`**, **`entry.data.seo`**, or both — see `getContentSeo` in `emdash/seo`.
 *
 * If we only read **`entry.seo`** when it exists, we can miss **`data.seo.image`** (the OG upload path).
 * `getSeoMeta` picks one object (`seo ?? data.seo`); live rows often split fields so **`seo.image` lives only
 * under `data.seo`**. Merge **`data.seo`** first, then overlay **`entry.seo`** so draft/top-level overrides
 * nested when both set the same key, while **`image` still flows up when only nested defines it.
 */
export function readEntrySeoRecord(entryMeta: Record<string, unknown>): Record<string, unknown> | null {
	const data = entryMeta.data;
	const nestedRaw =
		data && typeof data === 'object' && !Array.isArray(data)
			? (data as Record<string, unknown>).seo
			: undefined;
	const topRaw = entryMeta.seo;

	const nestedRec =
		nestedRaw && typeof nestedRaw === 'object' && !Array.isArray(nestedRaw)
			? (nestedRaw as Record<string, unknown>)
			: null;
	const topRec =
		topRaw && typeof topRaw === 'object' && !Array.isArray(topRaw)
			? (topRaw as Record<string, unknown>)
			: null;

	if (!nestedRec && !topRec) return null;
	if (!nestedRec) return topRec;
	if (!topRec) return nestedRec;
	return { ...nestedRec, ...topRec };
}

/**
 * Image for article push / recent-posts feed: same resolution as {@link resolveSocialImageSrc}
 * (**OG** / `_emdash_seo`, bare media ids, `social_image`, then **featured** / **cover**).
 */
export async function readArticleNotificationImagePath(
	entry: { id: string; data: Record<string, unknown> },
	siteOrigin: string,
): Promise<string | null> {
	const data = entry.data;
	const entryMeta = entry as unknown as Record<string, unknown>;
	const seo = readEntrySeoRecord(entryMeta);
	const slug = readString(data.slug) ?? undefined;
	return resolveSocialImageSrc(data, seo, {
		origin: siteOrigin.trim().replace(/\/$/, ''),
		emdashSeoLookup: { collection: 'posts', contentId: entry.id, slug },
	});
}

/**
 * When an image field is only a media row id (no `meta.storageKey`), resolve R2 `storage_key` from Turso.
 * Skips if the field already yields a public `/file/` path from {@link readFeaturedImageSrc}.
 */
function extractImageFieldMediaIdForLookup(raw: unknown): string | null {
	if (typeof raw === 'string') {
		const t = raw.trim();
		if (!t) return null;
		const parsed = tryParseJsonString(t);
		if (parsed && typeof parsed === 'object' && parsed !== null) {
			return extractImageFieldMediaIdForLookup(parsed);
		}
		if (normalizeToPublicMediaFilePath(t)) return null;
		if (/^[0-9A-HJKMNP-TV-Z]{20,36}$/i.test(t)) return t;
		return null;
	}
	if (raw && typeof raw === 'object') {
		const o = raw as Record<string, unknown>;
		const meta = o.meta && typeof o.meta === 'object' ? (o.meta as Record<string, unknown>) : null;
		if (
			readString(meta?.storageKey)
			?? readString(meta?.storage_key)
			?? readString(o.storageKey)
			?? readString(o.storage_key)
		) {
			return null;
		}
		const id = readString(o.id);
		if (id && /^[0-9A-HJKMNP-TV-Z]{20,36}$/i.test(id)) return id;
		const src = readString(o.src) ?? readString(o.url);
		if (
			src
			&& !normalizeToPublicMediaFilePath(src)
			&& /^[0-9A-HJKMNP-TV-Z]{20,36}$/i.test(src)
		) {
			return src;
		}
	}
	return null;
}

function workerSafeFetch():
	| ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
	| undefined {
	if (typeof globalThis.fetch !== 'function') return undefined;
	return (input: RequestInfo | URL, init?: RequestInit) => {
		if (input && typeof input === 'object' && 'url' in input) {
			const request = input as Request;
			return globalThis.fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				redirect: request.redirect,
				signal: request.signal,
				...(init || {}),
			});
		}
		return globalThis.fetch(input, init);
	};
}

export type ResolveSocialImageSrcOptions = {
	/** Same-origin base URL (e.g. `Astro.url.origin`) for resolving bare media ids without Turso. */
	origin?: string;
	/**
	 * EmDash stores admin SEO (`seo.image`) in **`_emdash_seo`**, not always in `entry.data.seo` JSON.
	 * Pass **`collection`** (`posts`, `pages`, …) and **`contentId`** (`entry.id`) so Turso can read **`seo_image`**.
	 */
	emdashSeoLookup?: { collection: string; contentId: string; slug?: string };
};

/** Try **`TURSO_DATABASE_URL`** first (matches Astro/emdash), then **`EMDASH_DATABASE_URL`** + same token. */
function createLibsqlClientForContentQueries(): ReturnType<typeof createClient> | null {
	const attempts: [string, string][] = [
		['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
		['EMDASH_DATABASE_URL', 'TURSO_AUTH_TOKEN'],
	];
	for (const [urlKey, tokenKey] of attempts) {
		const url = readOptionalEnv(urlKey).trim();
		const authToken = readOptionalEnv(tokenKey).trim();
		if (!url || !authToken) continue;
		return createClient({
			url,
			authToken,
			fetch: workerSafeFetch(),
		});
	}
	return null;
}

async function resolveStorageKeyFromMediaApi(origin: string, mediaId: string): Promise<string | null> {
	const base = origin.replace(/\/$/, '');
	try {
		const r = await fetch(`${base}/_emdash/api/media/${encodeURIComponent(mediaId)}`, {
			headers: { Accept: 'application/json' },
		});
		if (!r.ok) return null;
		const j = (await r.json()) as {
			data?: { item?: { storageKey?: string } };
			item?: { storageKey?: string };
		};
		const item = j.data?.item ?? j.item;
		const sk = item && typeof item.storageKey === 'string' ? item.storageKey.trim() : '';
		return sk.length > 0 ? sk : null;
	} catch {
		return null;
	}
}

const EMDASH_COLLECTION_TABLE: Record<string, string> = {
	posts: 'ec_posts',
	pages: 'ec_pages',
	archives: 'ec_archives',
};

function pickSeoImageRow(rows: unknown): string | null {
	const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
	const img = row && typeof row.seo_image === 'string' ? row.seo_image.trim() : '';
	return img.length > 0 ? img : null;
}

async function fetchEmdashSeoImageFromTable(
	collection: string,
	contentId: string,
	slug?: string | null,
): Promise<string | null> {
	const client = createLibsqlClientForContentQueries();
	if (!client) return null;
	try {
		if (contentId) {
			const res = await client.execute({
				sql: 'select seo_image from _emdash_seo where collection = ? and content_id = ? limit 1',
				args: [collection, contentId],
			});
			const found = pickSeoImageRow(res.rows);
			if (found) return found;
		}

		const table = EMDASH_COLLECTION_TABLE[collection];
		if (table && slug) {
			const res = await client.execute({
				sql: `select s.seo_image from _emdash_seo s inner join ${table} c on c.id = s.content_id where s.collection = ? and c.slug = ? limit 1`,
				args: [collection, slug],
			});
			return pickSeoImageRow(res.rows);
		}
	} catch {
		return null;
	}
	return null;
}

async function resolveMediaIdToPublicPath(
	mediaId: string,
	options?: ResolveSocialImageSrcOptions,
): Promise<string | null> {
	const client = createLibsqlClientForContentQueries();
	if (client) {
		try {
			const res = await client.execute({
				sql: 'select storage_key from media where id = ? limit 1',
				args: [mediaId],
			});
			const row = res.rows[0] as Record<string, unknown> | undefined;
			const key = row && typeof row.storage_key === 'string' ? row.storage_key.trim() : '';
			if (key.length > 0) {
				return `/_emdash/api/media/file/${key}`;
			}
		} catch (err) {
			console.error('[contentEntry] resolveSocialImageSrc Turso lookup failed', err);
		}
	}

	const origin = options?.origin?.trim();
	if (origin) {
		const sk = await resolveStorageKeyFromMediaApi(origin, mediaId);
		if (sk) return `/_emdash/api/media/file/${sk}`;
	}
	return null;
}

export async function resolveSocialImageSrc(
	data: Record<string, unknown>,
	seo?: Record<string, unknown> | null,
	options?: ResolveSocialImageSrcOptions,
): Promise<string | null> {
	const heroFallback =
		readFeaturedImageSrc(data.featured_image) ?? readFeaturedImageSrc(data.cover_image) ?? null;

	let fromSeo = seo ? readFeaturedImageSrc(seo.image) : null;
	if (!fromSeo && seo) {
		const seoMediaId = extractImageFieldMediaIdForLookup(seo.image);
		if (seoMediaId) fromSeo = await resolveMediaIdToPublicPath(seoMediaId, options);
	}
	if (!fromSeo && options?.emdashSeoLookup) {
		const lu = options.emdashSeoLookup;
		const raw = await fetchEmdashSeoImageFromTable(lu.collection, lu.contentId, lu.slug);
		if (raw) fromSeo = readFeaturedImageSrc(raw);
	}
	if (fromSeo) return fromSeo;

	const direct =
		readFeaturedImageSrc(data.social_image) ?? readFeaturedImageSrc(data.socialImage) ?? null;
	if (direct) return direct;

	const socialMediaId =
		extractImageFieldMediaIdForLookup(data.social_image)
		?? extractImageFieldMediaIdForLookup(data.socialImage);
	if (socialMediaId) {
		const fromSocial = await resolveMediaIdToPublicPath(socialMediaId, options);
		if (fromSocial) return fromSocial;
	}

	/**
	 * Bare `seo.image` ids may fail lookup if Turso is unset and media API is auth-only. Fall back to the
	 * hero so `og:image` / `twitter:image` are not empty when the post has a featured image.
	 */
	return heroFallback;
}

export function buildContentEntryViewModel(entry: { slug?: string; data: Record<string, unknown> } & Record<string, unknown>): ContentEntryViewModel {
	const data = entry.data;
	const entryMeta = entry as Record<string, unknown>;
	const seo = readEntrySeoRecord(entryMeta);

	const title =
		readString(data.title) ??
		readString(data.name) ??
		readString(data.headline) ??
		readString(entry.slug) ??
		'Untitled';
	const summary =
		readString(data.excerpt) ??
		readString(data.dek) ??
		readString(data.abstract) ??
		readString(data.description) ??
		null;
	const summaryParagraphs = summary
		? summary
			.split(/\n\s*\n+/)
			.map((paragraph) => paragraph.trim())
			.filter((paragraph) => paragraph.length > 0)
		: [];
	const { portableContent, textContent } = resolveEntryBody(data);
	const featuredImageSrc = readFeaturedImageSrc(data.featured_image) ?? readFeaturedImageSrc(data.cover_image);
	const featuredImageAlt =
		readString(data.featured_image_alt) ?? readString(data.cover_image_alt) ?? `${title} featured image`;
	const featuredImageCaption =
		readImageCaption(data.featured_image) ?? readImageCaption(data.cover_image);
	const socialImageSrc =
		readFeaturedImageSrc(seo?.image)
		?? readFeaturedImageSrc(data.social_image)
		?? readFeaturedImageSrc(data.socialImage)
		?? null;
	const volumeNumber =
		readNumber(data.volume_number)
		?? readNumber(data.volumeNumber)
		?? readNumber(title.match(/Vol\.\s*(\d+)/i)?.[1] ?? null);
	const rawRegionalVariant = readString(data.regional_variant) ?? readString(data.regionalVariant);
	const regionalVariant =
		rawRegionalVariant === 'Lancaster'
		|| rawRegionalVariant === 'Newcastle'
		|| rawRegionalVariant === 'Nottingham'
			? rawRegionalVariant
			: null;
	const pageImages = coerceImageList(data.page_images)
		.concat(coerceImageList(data.pageImages))
		.filter((value, index, all) => all.findIndex((item) => item.src === value.src) === index);
	const slidePageNumbers = pageImages.map((item, index) => item.pageNumber ?? index + 1);
	const slidePageTotal = slidePageNumbers.length > 0 ? Math.max(...slidePageNumbers) : 0;
	const pdfLink = normalizeEmdashMediaFileUrl(readMediaFileUrl(data.pdf_file) ?? '');
	const subjects = readSubjects(data.subjects);
	const issueDate = readString(data.date);
	const publishedAt = readEmDashPublishedOrCreatedAt(entry);
	const updatedAt = readEmDashUpdatedAt(entry);
	const primaryByline = readPrimaryByline(entryMeta, data);
	const subjectChips = subjects.map((subject) => {
		const colors = subjectColorTokens(subject);
		return {
			label: subject,
			style: `--subject-chip-bg: ${colors.bg}; --subject-chip-border: ${colors.border}; --subject-chip-text: ${colors.text};`,
		};
	});

	return {
		title,
		summaryParagraphs,
		portableContent,
		textContent,
		featuredImageSrc,
		featuredImageAlt,
		featuredImageCaption,
		socialImageSrc,
		volumeNumber,
		regionalVariant,
		pageImages,
		slidePageNumbers,
		slidePageTotal,
		pdfLink,
		subjects,
		subjectChips,
		issueDate,
		publishedAt,
		updatedAt,
		primaryByline,
	};
}
