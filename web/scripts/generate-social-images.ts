import fs from 'fs/promises';
import path from 'path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

import { SITE_DISPLAY_NAME } from '../src/lib/site-brand';

/** Open Graph / social share image size (Facebook, X, LinkedIn, etc.). */
const OG_WIDTH = 1200;
const OG_HEIGHT = 675;
const MAX_SOCIAL_IMAGE_BYTES = 600 * 1024;

/** Side margins (60px each); keeps headline inside the canvas before root overflow clips. */
const TITLE_BLOCK_MAX_PX = OG_WIDTH - 120;

/** Inset from canvas edges for the text stack (matches side margins). */
const CONTENT_INSET_PX = 60;

/** Share of canvas height reserved above {@link CONTENT_INSET_PX} for X/Twitter’s bottom title strip. */
const SOCIAL_CLIENT_BOTTOM_TITLEBAR_RESERVE_PX = 45;

/** Translucent white behind type (lower alpha = more see-through). */
const TITLE_PANEL_BG = 'rgba(255, 255, 255, 0.52)';

/** Max headline rows above the site / date line. */
const TITLE_MAX_LINES = 4;

/** Common named HTML entities (decode after numeric entities; &amp; handled in map). */
const HTML_NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: '\u00A0',
	ndash: '\u2013',
	mdash: '\u2014',
	hellip: '\u2026',
	lsquo: '\u2018',
	rsquo: '\u2019',
	ldquo: '\u201C',
	rdquo: '\u201D',
	bull: '\u2022',
	deg: '\u00B0',
	euro: '\u20AC',
	pound: '\u00A3',
	copy: '\u00A9',
	reg: '\u00AE',
};

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readDateCandidate(value: unknown): string | null {
	const v = readString(value);
	if (!v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeMediaFileUrl(value: unknown): string | null {
	if (!value) return null;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) return null;
		if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
			return trimmed;
		}
		return `/_emdash/api/media/file/${trimmed}`;
	}
	if (typeof value === 'object') {
		const rec = value as Record<string, unknown>;
		const src = readString(rec.src) ?? readString(rec.url);
		if (src) return src;
		const key = readString(rec.storageKey)
			?? readString(rec.storage_key)
			?? readString((rec.meta as Record<string, unknown> | undefined)?.storageKey)
			?? readString((rec.meta as Record<string, unknown> | undefined)?.storage_key);
		if (key) return `/_emdash/api/media/file/${key}`;
		const id = readString(rec.id);
		if (id) return `/_emdash/api/media/file/${id}`;
	}
	return null;
}

function decodeHtmlEntitiesOnce(value: string): string {
	let s = value
		.replace(/&#x([0-9a-f]{1,6});/gi, (full, hex) => {
			const cp = Number.parseInt(hex, 16);
			if (!Number.isFinite(cp) || cp < 0 || cp > 0x10_ffff) return full;
			try {
				return String.fromCodePoint(cp);
			} catch {
				return full;
			}
		})
		.replace(/&#(\d{1,7});/g, (full, dec) => {
			const cp = Number.parseInt(dec, 10);
			if (!Number.isFinite(cp) || cp < 0 || cp > 0x10_ffff) return full;
			try {
				return String.fromCodePoint(cp);
			} catch {
				return full;
			}
		});
	s = s.replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => HTML_NAMED_ENTITIES[name.toLowerCase()] ?? m);
	return s;
}

/** Unescape HTML entities; repeat passes so `&amp;#39;` etc. collapse correctly. */
function decodeHtmlEntities(value: string): string {
	let s = value;
	for (let i = 0; i < 6; i++) {
		const next = decodeHtmlEntitiesOnce(s);
		if (next === s) break;
		s = next;
	}
	return s;
}

function normalizeText(value: string): string {
	return decodeHtmlEntities(value)
		// Ornamental / uncommon quotes (often missing from display fonts → tofu); use ASCII.
		.replace(/[\u275D\u275E\u301D\u301E\u201C\u201D\u201E\u201F\u00AB\u00BB\uFF02]/g, '"')
		.replace(/[\u275B\u275C\u301F\u2018\u2019\u201A\u201B\uFF07]/g, "'")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/\u2013/g, '-')
		.replace(/\u2014/g, '--');
}

function formatDate(value: string | null): string {
	if (!value) return '';
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return '';
	return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Last line when more words remain: word-boundary ellipsis, avoid a clipped trailing word. */
function appendEllipsisToLine(segment: string, maxCharsPerLine: number): string {
	const trimmed = segment.replace(/[.,;:!?-]+$/u, '');
	const suf = '...';
	const parts = trimmed.split(/\s+/).filter(Boolean);
	if (parts.length >= 2) {
		parts.pop();
	}
	while (parts.length > 0) {
		const core = parts.join(' ');
		const totalLen = core.length + (core.length > 0 ? 1 : 0) + suf.length;
		if (totalLen <= maxCharsPerLine) break;
		parts.pop();
	}
	const lineText = parts.join(' ');
	return lineText.length > 0 ? `${lineText} ${suf}` : suf;
}

function wrapTitle(
	title: string,
	maxCharsPerLine = 28,
	maxLines = TITLE_MAX_LINES,
): string[] {
	const words = title.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return ['Untitled'];

	const lines: string[] = [];
	let wordIndex = 0;

	function fillLine(hardBreakOversizedWord: boolean): string {
		let line = '';
		while (wordIndex < words.length) {
			const w = words[wordIndex];
			const next = line.length > 0 ? `${line} ${w}` : w;
			if (next.length <= maxCharsPerLine) {
				line = next;
				wordIndex++;
			} else if (line.length === 0) {
				if (w.length > maxCharsPerLine && hardBreakOversizedWord) {
					line = `${w.slice(0, Math.max(1, maxCharsPerLine - 1))}…`;
				} else {
					line = w;
				}
				wordIndex++;
				break;
			} else {
				break;
			}
		}
		return line;
	}

	for (let lineIndex = 0; lineIndex < maxLines; lineIndex++) {
		if (wordIndex >= words.length) break;

		const isLastLine = lineIndex === maxLines - 1;
		const segment = fillLine(lineIndex === 0);

		if (segment.length === 0) break;

		if (isLastLine && wordIndex < words.length) {
			lines.push(appendEllipsisToLine(segment, maxCharsPerLine));
		} else {
			lines.push(segment);
		}
	}

	return lines.length > 0 ? lines : ['Untitled'];
}

async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer | null> {
	try {
		const { loadGoogleFontTtf } = await import('./lib/load-google-font-ttf.mjs');
		return await loadGoogleFontTtf(family, weight);
	} catch {
		return null;
	}
}

async function uploadMedia(filePath: string, altText: string, apiUrl: string, token: string) {
	const formData = new FormData();
	const fileBuffer = await fs.readFile(filePath);
	const blob = new Blob([fileBuffer], { type: 'image/png' });
	formData.append('file', blob, path.basename(filePath));
	formData.append('alt', altText);
	formData.append('name', path.basename(filePath));

	const uploadRes = await fetch(`${apiUrl}/_emdash/api/media`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`
		},
		body: formData as any
	});

	if (!uploadRes.ok) {
		const txt = await uploadRes.text();
		throw new Error(`Failed to upload media: ${uploadRes.status} ${txt}`);
	}
	return await uploadRes.json();
}

async function optimizePngUnderLimit(
	input: Buffer,
	maxBytes = MAX_SOCIAL_IMAGE_BYTES,
): Promise<Buffer> {
	if (input.byteLength <= maxBytes) return input;

	const attempts = [
		{ quality: 92, colors: 256, dither: 1.0 },
		{ quality: 88, colors: 192, dither: 0.95 },
		{ quality: 82, colors: 128, dither: 0.9 },
		{ quality: 76, colors: 96, dither: 0.85 },
		{ quality: 70, colors: 64, dither: 0.8 },
		{ quality: 62, colors: 48, dither: 0.75 },
	] as const;

	let best = input;
	for (const attempt of attempts) {
		const candidate = await sharp(input)
			.png({
				compressionLevel: 9,
				palette: true,
				quality: attempt.quality,
				colors: attempt.colors,
				dither: attempt.dither,
				effort: 10,
				progressive: false,
			})
			.toBuffer();
		if (candidate.byteLength < best.byteLength) {
			best = candidate;
		}
		if (candidate.byteLength <= maxBytes) {
			return candidate;
		}
	}

	return best;
}

type SocialFonts = { playfair: ArrayBuffer; noto900: ArrayBuffer };

type GenerateSlugOptions = { noPublish?: boolean; omitSocialImageClear?: boolean };

type PostListStatus = 'published' | 'draft';

/**
 * Slugs for posts in the given workflow states (draft + published are separate lists in EmDash).
 */
async function listPostSlugsForStatuses(
	apiUrl: string,
	token: string,
	statuses: PostListStatus[],
): Promise<string[]> {
	const { emdashMcpToolsCall } = await import('./emdash-mcp-client.mjs');
	const seen = new Set<string>();
	for (const status of statuses) {
		let cursor: string | undefined;
		do {
			const page = (await emdashMcpToolsCall(apiUrl, token, 'content_list', {
				collection: 'posts',
				status,
				limit: 100,
				...(cursor ? { cursor } : {}),
			})) as { items?: unknown[]; nextCursor?: string };
			const items = page.items;
			if (!Array.isArray(items)) break;
			for (const it of items) {
				if (it && typeof it === 'object' && typeof (it as { slug?: string }).slug === 'string') {
					seen.add((it as { slug: string }).slug);
				}
			}
			cursor = page.nextCursor;
		} while (cursor);
	}
	return Array.from(seen);
}

/** Crockford base32 media row id (EmDash ULIDs are 26 chars). */
function maybeMediaIdString(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const t = value.trim();
	return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(t) ? t : null;
}

function addIdsFromImageField(keep: Set<string>, img: unknown): void {
	if (!img || typeof img !== 'object') return;
	const id = (img as Record<string, unknown>).id;
	if (typeof id === 'string' && id.length > 0) keep.add(id);
}

const EMDASH_MEDIA_FILE_PREFIX = '/_emdash/api/media/file/';

/**
 * Value for **`ContentSeo.image`** that EmDash **admin** actually displays in the OG Image slot.
 * A REST GET on a manually fixed post shows this as a **same-origin file path**
 * (`/_emdash/api/media/file/<storageKey>`), not JSON MediaReference — JSON validates but the OG widget stays empty.
 *
 * **`POST /_emdash/api/media`** may return **snake_case** (`storage_key`); always normalize first.
 */
function seoImageFieldValueFromNormalizedRow(row: Record<string, unknown>): string {
	const storageKey = readString(row.storageKey as string);
	if (!storageKey) {
		throw new Error('seo.image: media row missing storageKey');
	}
	return `${EMDASH_MEDIA_FILE_PREFIX}${storageKey}`;
}

function normalizeMediaRowForSeoJson(raw: Record<string, unknown>): Record<string, unknown> {
	const storageKey =
		readString(raw.storageKey as string)
		?? readString(raw.storage_key as string | undefined);
	const mimeType =
		readString(raw.mimeType as string)
		?? readString(raw.mime_type as string | undefined)
		?? 'image/png';
	const filename =
		readString(raw.filename as string)
		?? readString(raw.name as string | undefined);
	return {
		id: raw.id,
		filename,
		mimeType,
		storageKey,
		width: raw.width ?? null,
		height: raw.height ?? null,
		alt: typeof raw.alt === 'string' ? raw.alt : '',
		caption: raw.caption ?? null,
		blurhash: raw.blurhash ?? raw.blur_hash ?? null,
		dominantColor: raw.dominantColor ?? raw.dominant_color ?? null,
	};
}

/**
 * Media ids referenced by posts (featured, legacy social, SEO OG, live snapshot).
 */
async function collectReferencedMediaIdsFromAllPosts(
	apiUrl: string,
	token: string,
): Promise<Set<string>> {
	const { emdashMcpContentGet } = await import('./emdash-mcp-client.mjs');
	const keep = new Set<string>();
	const slugs = await listPostSlugsForStatuses(apiUrl, token, ['published', 'draft']);
	for (const slug of slugs) {
		try {
			const { item } = await emdashMcpContentGet(apiUrl, token, { collection: 'posts', id: slug });
			const rec = item as Record<string, unknown>;
			const seo = rec.seo;
			if (seo && typeof seo === 'object') {
				const img = (seo as Record<string, unknown>).image;
				if (typeof img === 'string') {
					const t = img.trim();
					if (t.startsWith('{')) {
						try {
							const o = JSON.parse(t) as Record<string, unknown>;
							addIdsFromImageField(keep, o);
						} catch {
							/* ignore */
						}
					} else if (t.includes(EMDASH_MEDIA_FILE_PREFIX)) {
						const hint = normalizeSeoImageLookupHint(t);
						const row = await fetchMediaItemForRepair(apiUrl, token, hint);
						const id = row && typeof row.id === 'string' ? row.id : '';
						if (id) keep.add(id);
					} else {
						const mid = maybeMediaIdString(img);
						if (mid) keep.add(mid);
					}
				} else {
					addIdsFromImageField(keep, img);
				}
			}
			const data = rec.data as Record<string, unknown> | undefined;
			if (data) {
				addIdsFromImageField(keep, data.featured_image);
				addIdsFromImageField(keep, data.cover_image);
				addIdsFromImageField(keep, data.social_image);
			}
			const liveData = rec.liveData as Record<string, unknown> | undefined;
			if (liveData) {
				addIdsFromImageField(keep, liveData.featured_image);
				addIdsFromImageField(keep, liveData.social_image);
			}
		} catch {
			/* skip */
		}
	}
	return keep;
}

/**
 * Deletes PNG media whose filename ends with `-social.png` and is not referenced by any post.
 * Safe for generated OG cards; does not touch other assets.
 */
async function deleteUnreferencedSocialCardPngs(
	apiUrl: string,
	token: string,
	keepIds: Set<string>,
): Promise<{ deleted: number; examined: number }> {
	const { emdashMcpToolsCall } = await import('./emdash-mcp-client.mjs');
	let deleted = 0;
	let examined = 0;
	let cursor: string | undefined;
	do {
		const page = (await emdashMcpToolsCall(apiUrl, token, 'media_list', {
			mimeType: 'image/png',
			limit: 100,
			...(cursor ? { cursor } : {}),
		})) as { items?: Array<{ id?: string; filename?: string }>; nextCursor?: string };
		const items = page.items ?? [];
		for (const it of items) {
			examined++;
			const id = typeof it.id === 'string' ? it.id : '';
			const fn = typeof it.filename === 'string' ? it.filename : '';
			if (!id || !fn.endsWith('-social.png')) continue;
			if (keepIds.has(id)) continue;
			await emdashMcpToolsCall(apiUrl, token, 'media_delete', { id });
			deleted++;
			console.log(`media_delete orphan OG upload: ${id} (${fn})`);
		}
		cursor = page.nextCursor;
	} while (cursor);
	return { deleted, examined };
}

/** Latest item + revision token (REST matches admin / public content API). */
async function emdashContentGetRest(
	apiUrl: string,
	token: string,
	slug: string,
): Promise<{ item: Record<string, unknown>; _rev: string }> {
	const r = await fetch(
		`${apiUrl.replace(/\/$/, '')}/_emdash/api/content/posts/${encodeURIComponent(slug)}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			},
		},
	);
	const txt = await r.text();
	let j: { data?: { item?: Record<string, unknown>; _rev?: string }; error?: { message?: string } };
	try {
		j = JSON.parse(txt) as typeof j;
	} catch {
		throw new Error(`REST content GET: non-JSON (${r.status}): ${txt.slice(0, 400)}`);
	}
	if (!r.ok || !j.data?.item || typeof j.data._rev !== 'string') {
		const msg = j.error?.message ?? txt.slice(0, 400);
		throw new Error(`REST content GET failed (${r.status}): ${msg}`);
	}
	return { item: j.data.item, _rev: j.data._rev };
}

async function emdashContentPutRest(
	apiUrl: string,
	token: string,
	slug: string,
	body: Record<string, unknown>,
): Promise<void> {
	const r = await fetch(
		`${apiUrl.replace(/\/$/, '')}/_emdash/api/content/posts/${encodeURIComponent(slug)}`,
		{
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify(body),
		},
	);
	const txt = await r.text();
	if (!r.ok) {
		throw new Error(`REST content PUT ${r.status}: ${txt.slice(0, 600)}`);
	}
}

async function emdashContentPublishRest(apiUrl: string, token: string, slug: string): Promise<void> {
	const r = await fetch(
		`${apiUrl.replace(/\/$/, '')}/_emdash/api/content/posts/${encodeURIComponent(slug)}/publish`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
		},
	);
	const txt = await r.text();
	if (!r.ok) {
		throw new Error(`REST content publish ${r.status}: ${txt.slice(0, 600)}`);
	}
}

/** After a content PUT, optionally publish when EmDash left a pending draft revision. */
async function maybePublishAfterContentPut(
	apiUrl: string,
	token: string,
	slug: string,
	options: Pick<GenerateSlugOptions, 'noPublish'>,
): Promise<void> {
	const afterPut = await emdashContentGetRest(apiUrl, token, slug);
	const statusAfter = readString((afterPut.item as Record<string, unknown>).status);
	const draftRevisionId = (afterPut.item as Record<string, unknown>).draftRevisionId;
	const hasPendingDraft =
		draftRevisionId !== null && draftRevisionId !== undefined && String(draftRevisionId).length > 0;

	if (statusAfter === 'published' && !options.noPublish && hasPendingDraft) {
		try {
			await emdashContentPublishRest(apiUrl, token, slug);
			console.log('content_publish completed (draft → live)');
		} catch (e) {
			console.warn(
				'content_publish failed (SEO may still be live):',
				e instanceof Error ? e.message : e,
			);
		}
	} else if (statusAfter === 'published' && !options.noPublish && !hasPendingDraft) {
		console.log('content_publish skipped (no pending draft; PUT applied without separate draft)');
	}
}

async function emdashMediaGetRest(
	apiUrl: string,
	token: string,
	mediaId: string,
): Promise<Record<string, unknown> | null> {
	const r = await fetch(
		`${apiUrl.replace(/\/$/, '')}/_emdash/api/media/${encodeURIComponent(mediaId)}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
			},
		},
	);
	if (!r.ok) return null;
	const txt = await r.text();
	let j: { data?: { item?: Record<string, unknown> }; item?: Record<string, unknown> };
	try {
		j = JSON.parse(txt) as typeof j;
	} catch {
		return null;
	}
	const item = j.data?.item ?? j.item;
	return item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
}

function readStorageKeyFromMediaListItem(it: Record<string, unknown>): string | null {
	return (
		readString(it.storageKey as string)
		?? readString(it.storage_key as string | undefined)
	);
}

/**
 * Prefer REST GET by media row id; fall back to MCP **`media_list`**.
 * Match rows by **`id`** or **`storageKey`** (legacy scripts stored R2 keys like `….png`, which are
 * **not** the same ULID as `media.id` when uploads deduplicate).
 */
async function fetchMediaItemForRepair(
	apiUrl: string,
	token: string,
	hint: string,
): Promise<Record<string, unknown> | null> {
	const t = hint.trim();
	if (!t) return null;

	const byId = maybeMediaIdString(t);
	if (byId) {
		const direct = await emdashMediaGetRest(apiUrl, token, byId);
		if (direct) return direct;
	}

	const { emdashMcpToolsCall } = await import('./emdash-mcp-client.mjs');
	let cursor: string | undefined;
	do {
		const page = (await emdashMcpToolsCall(apiUrl, token, 'media_list', {
			limit: 100,
			...(cursor ? { cursor } : {}),
		})) as { items?: Array<Record<string, unknown>>; nextCursor?: string };
		for (const it of page.items ?? []) {
			if (typeof it.id === 'string' && it.id === t) return it;
			const sk = readStorageKeyFromMediaListItem(it);
			if (sk && sk === t) return it;
		}
		cursor = page.nextCursor;
	} while (cursor);
	return null;
}

/** Turns `/_emdash/api/media/file/<key>` or absolute URLs to that path into the raw **`storageKey`**. */
function normalizeSeoImageLookupHint(raw: string): string {
	let s = raw.trim();
	const filePrefix = '/_emdash/api/media/file/';
	try {
		if (s.includes('://')) {
			const u = new URL(s);
			if (u.pathname.startsWith(filePrefix)) {
				return decodeURIComponent(u.pathname.slice(filePrefix.length));
			}
		}
	} catch {
		/* ignore */
	}
	if (s.startsWith(filePrefix)) {
		return decodeURIComponent(s.slice(filePrefix.length));
	}
	return s;
}

/** True when `seo.image` is not the admin-working **same-origin `/file/…` path** (or empty). */
function seoImageRepairNeeded(img: unknown): boolean {
	if (img == null || img === '') return false;
	if (typeof img === 'object' && img !== null) return true;
	if (typeof img === 'string') {
		const t = img.trim();
		if (!t) return false;
		if (t.startsWith(EMDASH_MEDIA_FILE_PREFIX)) {
			const key = t.slice(EMDASH_MEDIA_FILE_PREFIX.length).trim();
			return key.length === 0;
		}
		try {
			if (t.includes('://')) {
				const u = new URL(t);
				if (
					u.pathname.startsWith(EMDASH_MEDIA_FILE_PREFIX)
					&& u.pathname.slice(EMDASH_MEDIA_FILE_PREFIX.length).trim().length > 0
				) {
					return false;
				}
			}
		} catch {
			/* fall through */
		}
		return true;
	}
	return false;
}

/**
 * Rewrites **`seo.image`** to **`/_emdash/api/media/file/<storageKey>`** (or bare id / JSON / URL → fetch row) — **no PNG regen**.
 */
type RepairSeoImageOptions = Pick<GenerateSlugOptions, 'noPublish'> & {
	/** Re-fetch media and rewrite `seo.image` even when the current value passes the heuristic check. */
	forceRepair?: boolean;
};

async function repairSeoImageShapeForSlug(
	apiUrl: string,
	token: string,
	slug: string,
	options: RepairSeoImageOptions,
): Promise<'skipped' | 'updated' | 'failed'> {
	let item: Record<string, unknown>;
	let _rev: string;
	try {
		({ item, _rev } = await emdashContentGetRest(apiUrl, token, slug));
	} catch (e) {
		console.warn(`[repair] ${slug}: GET failed —`, e instanceof Error ? e.message : e);
		return 'failed';
	}

	const seo = item.seo;
	const img =
		seo && typeof seo === 'object'
			? (seo as Record<string, unknown>).image
			: undefined;

	if (!options.forceRepair && !seoImageRepairNeeded(img)) {
		console.log(`[repair] ${slug}: skip (seo.image already admin file path or empty)`);
		return 'skipped';
	}

	let lookupHint: string | null = null;
	if (typeof img === 'string') {
		const t = normalizeSeoImageLookupHint(img);
		if (t.startsWith('{')) {
			try {
				const o = JSON.parse(t) as Record<string, unknown>;
				const meta = o.meta && typeof o.meta === 'object' ? (o.meta as Record<string, unknown>) : null;
				lookupHint =
					readString(o.id)
					?? readString(o.storageKey as string | undefined)
					?? readString(o.storage_key as string | undefined)
					?? readString(meta?.storageKey as string | undefined)
					?? readString(meta?.storage_key as string | undefined)
					?? null;
			} catch {
				lookupHint = t;
			}
		} else {
			lookupHint = t;
		}
	} else if (img && typeof img === 'object') {
		const o = img as Record<string, unknown>;
		const meta = o.meta && typeof o.meta === 'object' ? (o.meta as Record<string, unknown>) : null;
		lookupHint =
			readString(o.id)
			?? readString(o.storageKey as string)
			?? readString(o.storage_key as string | undefined)
			?? readString(meta?.storageKey as string)
			?? readString(meta?.storage_key as string | undefined);
	}

	if (!lookupHint) {
		console.warn(`[repair] ${slug}: skip (cannot derive lookup hint from seo.image)`);
		return 'skipped';
	}

	const raw = await fetchMediaItemForRepair(apiUrl, token, lookupHint);
	if (!raw) {
		const hintDisp =
			lookupHint.length > 56 ? `${lookupHint.slice(0, 56)}…` : lookupHint;
		console.warn(`[repair] ${slug}: could not resolve media for hint ${hintDisp}`);
		return 'failed';
	}

	const normalized = normalizeMediaRowForSeoJson(raw);
	const imageValue = seoImageFieldValueFromNormalizedRow(normalized);
	if (!readString(normalized.storageKey as string)) {
		console.warn(`[repair] ${slug}: media row missing storageKey`);
		return 'failed';
	}

	const existingSeo =
		seo && typeof seo === 'object' && seo !== null
			? { ...(seo as Record<string, unknown>) }
			: {};
	const seoPayload = { ...existingSeo, image: imageValue };

	try {
		await emdashContentPutRest(apiUrl, token, slug, { seo: seoPayload, _rev });
	} catch (e) {
		console.warn(`[repair] ${slug}: PUT failed —`, e instanceof Error ? e.message : e);
		return 'failed';
	}

	console.log(
		`[repair] ${slug}: updated seo.image → ${imageValue} (media ${readString(normalized.id as string)})`,
	);
	await maybePublishAfterContentPut(apiUrl, token, slug, options);
	return 'updated';
}

async function resolveApiAndToken(): Promise<{ apiUrl: string; token: string }> {
	const apiUrl =
		process.env.EMDASH_URL || process.env.EMDASH_STAGING_URL || 'https://staging.freedomtimes.news';
	let token =
		process.env.EMDASH_TOKEN?.trim()
		|| process.env.EMDASH_MCP_TOKEN?.trim()
		|| process.env.EMDASH_STAGING_TOKEN?.trim()
		|| '';

	if (!token) {
		try {
			const authPath = path.join(
				process.env.USERPROFILE || process.env.HOME || '',
				'.config',
				'emdash',
				'auth.json',
			);
			const authData = JSON.parse(await fs.readFile(authPath, 'utf8'));
			if (authData[apiUrl] && authData[apiUrl].accessToken) {
				token = authData[apiUrl].accessToken;
			}
		} catch {
			console.log('Could not read auth.json, proceeding with empty token.');
		}
	}

	return { apiUrl, token };
}

async function loadSocialFonts(): Promise<SocialFonts> {
	const [playfair, noto900] = await Promise.all([
		loadGoogleFont('Playfair Display', 900),
		loadGoogleFont('Noto Sans', 900),
	]);
	if (!playfair || !noto900) {
		throw new Error('Could not load fonts (Playfair Display and Noto Sans required)');
	}
	return { playfair, noto900 };
}

async function tryLoadAuthJsonAccessToken(apiUrl: string): Promise<string | null> {
	const normalized = apiUrl.replace(/\/$/, '');
	try {
		const authPath = path.join(
			process.env.USERPROFILE || process.env.HOME || '',
			'.config',
			'emdash',
			'auth.json',
		);
		const raw = JSON.parse(await fs.readFile(authPath, 'utf8')) as Record<
			string,
			{ accessToken?: string }
		>;
		const direct =
			raw[normalized]?.accessToken
			?? raw[`${normalized}/`]?.accessToken
			?? raw[apiUrl]?.accessToken;
		if (typeof direct === 'string' && direct.trim().length > 0) {
			return direct.trim();
		}
		// Some auth files only list a variant (e.g. with/without `www.`, or `http` vs `https`)
		const lowerNeedle = normalized.toLowerCase().replace(/^www\./, '');
		for (const [key, entry] of Object.entries(raw)) {
			const k = key.replace(/\/$/, '').toLowerCase().replace(/^www\./, '');
			if (
				k === lowerNeedle
				|| k.endsWith(lowerNeedle)
				|| lowerNeedle.endsWith(k)
				|| (lowerNeedle.includes('freedomtimes') && k.includes('freedomtimes'))
			) {
				const t = entry?.accessToken;
				if (typeof t === 'string' && t.trim().length > 0) return t.trim();
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Prefer REST content GET; fall back to MCP **`content_get`** when REST returns **401/403**.
 * If both fail (e.g. expired **`EMDASH_TOKEN`** in `.env`), retries once with **`~/.config/emdash/auth.json`**
 * when that token differs — stale env tokens often shadow a valid CLI login.
 */
async function fetchPostItemWithToken(
	apiUrl: string,
	bearer: string,
	slug: string,
): Promise<Record<string, unknown>> {
	const url = `${apiUrl.replace(/\/$/, '')}/_emdash/api/content/posts/${encodeURIComponent(slug)}`;
	const getRes = await fetch(url, {
		headers: {
			Authorization: `Bearer ${bearer}`,
			Accept: 'application/vnd.emdash.portable-text+json, application/json',
		},
	});

	if (getRes.ok) {
		const rawItem = (await getRes.json()) as Record<string, unknown>;
		console.log('Raw item keys:', Object.keys(rawItem));
		console.log('Raw item data keys:', rawItem.data ? Object.keys(rawItem.data as object) : 'undefined');
		const postItem = (rawItem.data as { item?: Record<string, unknown> } | undefined)?.item ?? rawItem;
		return postItem as Record<string, unknown>;
	}

	const bodyPreview = await getRes.text().catch(() => '');
	if ((getRes.status === 401 || getRes.status === 403) && bearer.length > 0) {
		console.warn(
			`REST content GET ${getRes.status}; falling back to MCP content_get (${bodyPreview.slice(0, 120)})`,
		);
		const { emdashMcpContentGet } = await import('./emdash-mcp-client.mjs');
		const { item } = await emdashMcpContentGet(apiUrl, bearer, {
			collection: 'posts',
			id: slug,
		});
		return item as Record<string, unknown>;
	}

	throw new Error(`Failed to fetch post: ${getRes.status} ${bodyPreview.slice(0, 400)}`);
}

async function fetchPostItemForGeneration(
	apiUrl: string,
	token: string,
	slug: string,
): Promise<{ postItem: Record<string, unknown>; bearerUsed: string }> {
	try {
		const postItem = await fetchPostItemWithToken(apiUrl, token, slug);
		return { postItem, bearerUsed: token };
	} catch (firstErr) {
		const fallback = await tryLoadAuthJsonAccessToken(apiUrl);
		if (!fallback || fallback === token) {
			throw firstErr;
		}
		console.warn(
			'Primary token failed; retrying with ~/.config/emdash/auth.json (remove stale EMDASH_* in .env if this works).',
		);
		const postItem = await fetchPostItemWithToken(apiUrl, fallback, slug);
		return { postItem, bearerUsed: fallback };
	}
}

/**
 * Fetches post, renders OG PNG, uploads media (R2), sets `seo.image` via **REST PUT**.
 * For already-published posts, POST `…/publish` unless `--no-publish`.
 *
 * Note: EmDash bumps `updatedAt` on every successful PUT/publish; there is no supported API to preserve it.
 */

async function generateSocialImageForSlug(
	apiUrl: string,
	token: string,
	slug: string,
	fonts: SocialFonts,
	options: GenerateSlugOptions = {},
): Promise<void> {
	console.log(`Fetching post ${slug} from ${apiUrl}...`);

	const { postItem, bearerUsed: apiToken } = await fetchPostItemForGeneration(apiUrl, token, slug);
	const data = (postItem?.data ?? {}) as Record<string, unknown>;
	const title = readString(data.title)
		?? readString(data.name)
		?? readString(data.headline)
		?? readString(postItem?.slug)
		?? 'Untitled';
	const featuredImageSrc =
		normalizeMediaFileUrl(data.featured_image)
		?? normalizeMediaFileUrl(data.cover_image);
	const publishedAt =
		readDateCandidate((postItem as Record<string, unknown>)?.publishedAt)
		?? readDateCandidate((postItem as Record<string, unknown>)?.published_at)
		?? readDateCandidate(data.publishedAt)
		?? readDateCandidate(data.published_at)
		?? readDateCandidate((postItem as Record<string, unknown>)?.updatedAt)
		?? readDateCandidate((postItem as Record<string, unknown>)?.updated_at)
		?? readDateCandidate(data.updatedAt)
		?? readDateCandidate(data.updated_at);

	console.log("Extracted title:", title);
	console.log("data.title:", data.title);
	if (!readString(data.title as string | undefined)) {
		console.warn("WARNING: Title is missing from data!");
	}

	let bgUrl = featuredImageSrc ? new URL(featuredImageSrc, apiUrl).toString() : '';
	// Use absolute internal URL for fetching if relative
	if (featuredImageSrc?.startsWith('/')) {
		bgUrl = `${apiUrl}${featuredImageSrc}`;
	}

	const normalizedTitle = normalizeText(title);
	const titleLines = wrapTitle(normalizedTitle);
	const dateText = formatDate(publishedAt);
	
	const titleLineStyle = {
		marginBottom: '8px',
		display: 'flex' as const,
		maxWidth: `${TITLE_BLOCK_MAX_PX}px`,
		backgroundColor: TITLE_PANEL_BG,
		padding: '16px 24px',
		color: '#000000',
		lineHeight: 1.08,
		fontFamily: '"Playfair Display", "Noto Sans"',
	};

	const titleNodes = titleLines.map((line) => ({
		type: 'div',
		props: {
			style: titleLineStyle,
			children: line,
		},
	}));

	let bgImageNode = null;
	if (bgUrl) {
		// Read the image directly to an ArrayBuffer or base64 to pass to Satori
		try {
			console.log(`Fetching bg image ${bgUrl}...`);
			const res = await fetch(bgUrl, {
				headers: { Authorization: `Bearer ${apiToken}` }
			});
			if (res.ok) {
				const buffer = await res.arrayBuffer();
				const base64 = Buffer.from(buffer).toString('base64');
				const mimeType = res.headers.get('content-type') || 'image/jpeg';
				console.log(`Fetched bg image, buffer size: ${buffer.byteLength}, type: ${mimeType}`);
				bgImageNode = {
					type: 'div',
					props: {
						style: {
							position: 'absolute',
							left: 0,
							top: 0,
							width: `${OG_WIDTH}px`,
							height: `${OG_HEIGHT}px`,
							backgroundImage: `url('data:${mimeType};base64,${base64}')`,
							backgroundSize: 'cover',
							backgroundPosition: 'center',
						},
					},
				};
			} else {
				console.error(`Failed to fetch bg image: ${res.status}`);
			}
		} catch (e) {
			console.error("Failed to load bg image", e);
		}
	}

	const { playfair: fontPlayfair, noto900: fontNoto900 } = fonts;

	console.log("Generating layout with Satori...");
	const vdom = {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				position: 'relative',
				width: `${OG_WIDTH}px`,
				height: `${OG_HEIGHT}px`,
				background: '#ffffff',
				overflow: 'hidden',
			},
			children: [
				bgImageNode,
				{
					type: 'div',
					props: {
						style: {
							position: 'absolute',
							left: `${CONTENT_INSET_PX}px`,
							right: `${CONTENT_INSET_PX}px`,
							bottom: `${CONTENT_INSET_PX + SOCIAL_CLIENT_BOTTOM_TITLEBAR_RESERVE_PX}px`,
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'flex-start',
							justifyContent: 'flex-end',
						},
						children: [
							{
								type: 'div',
								props: {
									style: {
										display: 'flex',
										flexDirection: 'column',
										alignItems: 'flex-start',
										maxWidth: `${TITLE_BLOCK_MAX_PX}px`,
										fontSize: '72px',
										fontWeight: 900,
										letterSpacing: '-0.01em',
									},
									children: titleNodes,
								},
							},
							{
								type: 'div',
								props: {
									style: {
										display: 'flex',
										fontSize: '32px',
										fontWeight: 900,
										color: '#000000',
										fontFamily: '"Playfair Display", "Noto Sans"',
										letterSpacing: '-0.01em',
										marginTop: '16px',
										maxWidth: `${TITLE_BLOCK_MAX_PX}px`,
										backgroundColor: TITLE_PANEL_BG,
										padding: '12px 24px',
									},
									children: `${SITE_DISPLAY_NAME}  •  freedomtimes.news${dateText ? `  •  ${dateText}` : ''}`,
								},
							},
						]
					}
				}
			].filter(Boolean)
		}
	};

	const svg = await satori(vdom as any, {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		fonts: [
			{ name: 'Playfair Display', data: fontPlayfair, weight: 900, style: 'normal' },
			{ name: 'Noto Sans', data: fontNoto900, weight: 900, style: 'normal' },
		],
	});

	console.log("Rendering PNG with Resvg...");
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: OG_WIDTH },
	});
	const pngDataRaw = resvg.render().asPng();
	const pngData = await optimizePngUnderLimit(pngDataRaw);
	const outPath = path.join(process.cwd(), '.release', `${slug}-social.png`);
	await fs.mkdir(path.dirname(outPath), { recursive: true });
	await fs.writeFile(outPath, pngData);
	const pngBytes = pngData.byteLength;
	if (pngBytes > MAX_SOCIAL_IMAGE_BYTES) {
		throw new Error(
			`Social image is ${pngBytes} bytes after optimization; must be <= ${MAX_SOCIAL_IMAGE_BYTES}.`,
		);
	}
	console.log(`Saved PNG to ${outPath} (${pngBytes} bytes)`);

	console.log(`Uploading to EmDash...`);
	const uploadResult = await uploadMedia(outPath, `${normalizedTitle} share preview`, apiUrl, apiToken);
	console.log("Upload result:", uploadResult);

	console.log("featured_image is:", JSON.stringify(data.featured_image, null, 2));

	console.log(`Updating post ${slug} (REST PUT seo.image)...`);
	const uploaded = uploadResult.data.item as Record<string, unknown>;
	if (!readString(uploaded.id as string)) {
		throw new Error('Upload response missing id; cannot set seo.image');
	}
	const uploadedNorm = normalizeMediaRowForSeoJson(uploaded);
	if (!readString(uploadedNorm.storageKey as string)) {
		throw new Error(
			'Upload response missing storage_key/storageKey; cannot set seo.image admin file path.',
		);
	}

	const { item: latest, _rev } = await emdashContentGetRest(apiUrl, apiToken, slug);
	const existingSeo = latest.seo;
	/** **`ContentSeoInput.image`** is a string. EmDash admin shows OG preview when it is the same `/file/…` path as for inline media, not JSON MediaReference. */
	const seoPayload = {
		...(typeof existingSeo === 'object' && existingSeo !== null ? { ...(existingSeo as Record<string, unknown>) } : {}),
		image: seoImageFieldValueFromNormalizedRow(uploadedNorm),
	};

	const putBody: Record<string, unknown> = {
		seo: seoPayload,
		_rev,
	};
	if (!options.omitSocialImageClear) {
		putBody.data = { social_image: null };
	}

	console.log('REST content PUT (partial data + seo.image)...');
	try {
		await emdashContentPutRest(apiUrl, apiToken, slug, putBody);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (
			!options.omitSocialImageClear
			&& /social_image|Unknown field|unknown field|VALIDATION_ERROR/i.test(msg)
		) {
			console.warn('Retrying PUT without data.social_image (field may be removed from schema)...');
			const { _rev: rev2 } = await emdashContentGetRest(apiUrl, apiToken, slug);
			await emdashContentPutRest(apiUrl, apiToken, slug, { seo: seoPayload, _rev: rev2 });
		} else {
			throw e;
		}
	}
	console.log('REST content PUT completed');

	await maybePublishAfterContentPut(apiUrl, apiToken, slug, options);

	console.log('Success!');
}

function parseCliArgs(argv: string[]): {
	slug?: string;
	all: boolean;
	publishedOnly: boolean;
	noPublish: boolean;
	dropSocialImageField: boolean;
	noCleanupMedia: boolean;
	repairSeoImageShape: boolean;
	repairSeoImageForce: boolean;
} {
	const flags = new Set(argv.filter((a) => a.startsWith('--')));
	const pos = argv.filter((a) => !a.startsWith('--'));
	const all = flags.has('--all');
	const publishedOnly = flags.has('--published-only');
	const noPublish = flags.has('--no-publish');
	const dropSocialImageField = flags.has('--drop-social-image-field');
	const noCleanupMedia = flags.has('--no-cleanup-media');
	const repairSeoImageShape = flags.has('--repair-seo-image-shape');
	const repairSeoImageForce = flags.has('--force');
	const slug = pos[0];
	return {
		slug,
		all,
		publishedOnly,
		noPublish,
		dropSocialImageField,
		noCleanupMedia,
		repairSeoImageShape,
		repairSeoImageForce,
	};
}

async function main() {
	const {
		slug,
		all,
		publishedOnly,
		noPublish,
		dropSocialImageField,
		noCleanupMedia,
		repairSeoImageShape,
		repairSeoImageForce,
	} = parseCliArgs(process.argv.slice(2));
	const genOpts: GenerateSlugOptions = {
		noPublish,
		omitSocialImageClear: dropSocialImageField,
	};

	const { apiUrl, token } = await resolveApiAndToken();

	if (!token) {
		console.error('No bearer token: set EMDASH_TOKEN / EMDASH_STAGING_TOKEN or use ~/.config/emdash/auth.json');
		process.exit(1);
	}

	if (repairSeoImageShape) {
		if (dropSocialImageField) {
			console.error('Cannot combine --repair-seo-image-shape with --drop-social-image-field.');
			process.exit(1);
		}
		if (!slug && !all) {
			console.error(
				'Usage: tsx scripts/generate-social-images.ts --repair-seo-image-shape <slug>',
			);
			console.error(
				'       tsx scripts/generate-social-images.ts --repair-seo-image-shape --all [--published-only]',
			);
			process.exit(1);
		}
		if (publishedOnly && !all) {
			console.error('--published-only only applies with --all');
			process.exit(1);
		}
		if (all && slug) {
			console.error('Use either --repair-seo-image-shape --all or one slug, not both.');
			process.exit(1);
		}

		const repairOpts: RepairSeoImageOptions = {
			noPublish,
			...(repairSeoImageForce ? { forceRepair: true } : {}),
		};

		if (all) {
			const statuses: PostListStatus[] = publishedOnly ? ['published'] : ['published', 'draft'];
			const slugs = await listPostSlugsForStatuses(apiUrl, token, statuses);
			const scope = publishedOnly ? 'published' : 'published + draft';
			console.log(
				`Repairing seo.image shape for ${slugs.length} post(s) (${scope}) at ${apiUrl}${
					repairSeoImageForce ? ' (--force: rewrite all)' : ''
				}...\n`,
			);
			let updated = 0;
			let skipped = 0;
			let failed = 0;
			for (let i = 0; i < slugs.length; i++) {
				const s = slugs[i];
				console.log(`\n=== [${i + 1}/${slugs.length}] ${s} ===`);
				const outcome = await repairSeoImageShapeForSlug(apiUrl, token, s, repairOpts);
				if (outcome === 'updated') updated++;
				else if (outcome === 'skipped') skipped++;
				else failed++;
			}
			console.log(
				`\nRepair done. updated=${updated} skipped=${skipped} failed=${failed}`,
			);
			if (failed) process.exit(1);
			return;
		}

		const outcome = await repairSeoImageShapeForSlug(apiUrl, token, slug!, repairOpts);
		if (outcome === 'failed') process.exit(1);
		return;
	}

	if (!slug && !all) {
		console.error('Usage: tsx scripts/generate-social-images.ts <slug>');
		console.error('       tsx scripts/generate-social-images.ts --all   # draft + published posts');
		console.error('       tsx scripts/generate-social-images.ts --all --published-only');
		console.error('       tsx scripts/generate-social-images.ts --all --no-publish   # skip content_publish');
		console.error(
			'       tsx scripts/generate-social-images.ts --all --drop-social-image-field   # remove Social Image field + regenerate + orphan cleanup',
		);
		console.error('       tsx scripts/generate-social-images.ts --all --no-cleanup-media   # skip deleting orphan *-social.png');
		console.error(
			'       tsx scripts/generate-social-images.ts --repair-seo-image-shape --all   # fix admin OG field (no PNG regen)',
		);
		console.error(
			'       tsx scripts/generate-social-images.ts --repair-seo-image-shape --all --force   # re-fetch media + rewrite every post',
		);
		process.exit(1);
	}

	if (dropSocialImageField) {
		const { emdashMcpToolsCall } = await import('./emdash-mcp-client.mjs');
		console.log('Removing posts.social_image from schema (schema_delete_field)...');
		try {
			await emdashMcpToolsCall(apiUrl, token, 'schema_delete_field', {
				collection: 'posts',
				fieldSlug: 'social_image',
			});
			console.log('Schema field social_image removed.');
		} catch (err) {
			console.warn(
				'schema_delete_field failed (field may already be gone):',
				err instanceof Error ? err.message : err,
			);
		}
	}

	if (all && slug) {
		console.error('Use either --all or one slug, not both.');
		process.exit(1);
	}

	if (publishedOnly && !all) {
		console.error('--published-only only applies with --all');
		process.exit(1);
	}

	const fonts = await loadSocialFonts();

	if (all) {
		const statuses: PostListStatus[] = publishedOnly ? ['published'] : ['published', 'draft'];
		const slugs = await listPostSlugsForStatuses(apiUrl, token, statuses);
		const scope = publishedOnly ? 'published' : 'published + draft';
		console.log(`Regenerating OG images for ${slugs.length} post(s) (${scope}) at ${apiUrl}...\n`);
		const failed: string[] = [];
		for (let i = 0; i < slugs.length; i++) {
			const s = slugs[i];
			console.log(`\n=== [${i + 1}/${slugs.length}] ${s} ===`);
			try {
				await generateSocialImageForSlug(apiUrl, token, s, fonts, genOpts);
			} catch (e) {
				console.error(e instanceof Error ? e.message : e);
				failed.push(s);
			}
		}
		console.log(
			`\nDone. ok=${slugs.length - failed.length} failed=${failed.length}${
				failed.length ? `: ${failed.join(', ')}` : ''
			}`,
		);
		if (failed.length) process.exit(1);

		if (!noCleanupMedia) {
			console.log('\n--- Orphan OG PNG cleanup (*-social.png not referenced by any post) ---');
			const keepIds = await collectReferencedMediaIdsFromAllPosts(apiUrl, token);
			const { deleted, examined } = await deleteUnreferencedSocialCardPngs(apiUrl, token, keepIds);
			console.log(
				JSON.stringify({ orphanSocialPngDeleted: deleted, pngRowsExamined: examined, keepMediaIds: keepIds.size }),
			);
		}
		return;
	}

	try {
		await generateSocialImageForSlug(apiUrl, token, slug!, fonts, genOpts);
	} catch (e) {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
