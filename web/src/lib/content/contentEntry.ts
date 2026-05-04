import { resolveEntryBody } from './entryBody';

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

function readDateCandidate(value: unknown): string | null {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}
	if (value instanceof Date && Number.isFinite(value.getTime())) {
		return value.toISOString();
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

function readFeaturedImageSrc(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	if (value && typeof value === 'object') {
		const candidate = value as Record<string, unknown>;
		const src = readString(candidate.src) ?? readString(candidate.url);
		if (src) {
			return src;
		}

		const meta =
			candidate.meta && typeof candidate.meta === 'object'
				? (candidate.meta as Record<string, unknown>)
				: null;
		const storageKey = readString(meta?.storageKey) ?? readString(candidate.storageKey);
		if (storageKey) {
			return `/_emdash/api/media/file/${storageKey}`;
		}

		const mediaId = readString(candidate.id);
		if (mediaId) {
			return `/_emdash/api/media/file/${mediaId}`;
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
		const storageKey = readString(meta?.storageKey) ?? readString(candidate.storageKey);
		if (storageKey) {
			return `/_emdash/api/media/file/${storageKey}`;
		}

		const mediaId = readString(candidate.id);
		if (mediaId) {
			return `/_emdash/api/media/file/${mediaId}`;
		}

		const mediaRef = readString(candidate._ref);
		if (mediaRef) {
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

export function buildContentEntryViewModel(entry: { slug?: string; data: Record<string, unknown> } & Record<string, unknown>): ContentEntryViewModel {
	const data = entry.data;
	const entryMeta = entry as Record<string, unknown>;

	const title =
		readString(data.title) ??
		readString(data.name) ??
		readString(data.headline) ??
		readString(entry.slug) ??
		'Untitled';
	const summary =
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
	const publishedAt =
		readDateCandidate(entryMeta.publishedAt)
		?? readDateCandidate(entryMeta.published_at)
		?? readDateCandidate(data.publishedAt)
		?? readDateCandidate(data.published_at)
		?? readDateCandidate(entryMeta.createdAt)
		?? readDateCandidate(entryMeta.created_at)
		?? readDateCandidate(data.createdAt)
		?? readDateCandidate(data.created_at);
	const updatedAt =
		readDateCandidate(entryMeta.updatedAt)
		?? readDateCandidate(entryMeta.updated_at)
		?? readDateCandidate(data.updatedAt)
		?? readDateCandidate(data.updated_at);
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
