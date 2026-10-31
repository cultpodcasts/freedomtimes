import { createClient } from '@libsql/client/web';

import { readOptionalEnv } from '../auth';
import { resolveEntryBody } from './entryBody';
import { readImageCaption } from './imageCaption';
import { resolveHeroImage } from './heroImage';
import { readMediaValueSrc as readFeaturedImageSrc } from './mediaValue';
import {
	readEmDashPublishedOrCreatedAt,
	readEmDashUpdatedAt,
} from './emdashTimestamps';
import { readMediaLibraryFileUrl as readMediaFileUrl } from './mediaFileUrl';
import {
	resolveSocialImageSrcWith,
	type ResolveSocialImageSrcOptions,
	type SocialImageQueryClient,
} from './socialImage';

export type { ResolveSocialImageSrcOptions } from './socialImage';

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
	/** Primary byline record's website/profile URL, when set. */
	primaryBylineUrl: string | null;
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

function readPrimaryBylineRecord(entryMeta: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> | null {
	const direct = (
		(entryMeta.byline && typeof entryMeta.byline === 'object' ? entryMeta.byline : null)
		?? (data.byline && typeof data.byline === 'object' ? data.byline : null)
	) as Record<string, unknown> | null;
	if (direct) return direct;
	const bylinesArray = (
		(Array.isArray(entryMeta.bylines) ? entryMeta.bylines : null)
		?? (Array.isArray(data.bylines) ? data.bylines : null)
	) as unknown[] | null;
	const first = bylinesArray && bylinesArray.length > 0 ? (bylinesArray[0] as Record<string, unknown>) : null;
	if (first && first.byline && typeof first.byline === 'object') return first.byline as Record<string, unknown>;
	return first;
}

export function readPrimaryBylineUrl(entryMeta: Record<string, unknown>, data: Record<string, unknown>): string | null {
	const rec = readPrimaryBylineRecord(entryMeta, data);
	const raw = rec ? (readString(rec.websiteUrl) ?? readString(rec.website_url)) : null;
	if (!raw) return null;
	try {
		const u = new URL(raw);
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
	} catch {
		return null;
	}
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

/**
 * Try **`TURSO_DATABASE_URL`** first (matches Astro/emdash), then **`EMDASH_DATABASE_URL`** + same token.
 * `createClient` can throw synchronously (malformed URL, or a `file:` scheme the web client rejects);
 * {@link resolveSocialImageSrcWith} calls this inside its error handling (#125).
 */
function createLibsqlClientForContentQueries(): SocialImageQueryClient | null {
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

/**
 * OG image for an entry. Never rejects: safe to await from component frontmatter after the headers
 * are sent (#125). Resolution order and fallbacks: `./socialImage.ts`.
 */
export function resolveSocialImageSrc(
	data: Record<string, unknown>,
	seo?: Record<string, unknown> | null,
	options?: ResolveSocialImageSrcOptions,
): Promise<string | null> {
	return resolveSocialImageSrcWith(createLibsqlClientForContentQueries, data, seo, options);
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
	// #108: src and alt come from the same (rendered) field; the generic alt is only a fallback.
	const { src: featuredImageSrc, alt: featuredImageAlt } = resolveHeroImage(data, title);
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
	const primaryBylineUrl = readPrimaryBylineUrl(entryMeta, data);
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
		primaryBylineUrl,
	};
}
