/**
 * Optional `<video poster>` for the one self-hosted player.
 * The same `poster` extra is read on an EmDash 1.2.0 video block and on an older
 * `_type: "embed"` + `provider: "video"` node.
 *
 * Schema has no poster field. The extra persists via content_update.
 *
 * ```ts
 * poster?: string | {
 *   url?: string
 *   src?: string
 *   id?: string            // storage key with an image extension, e.g. 01ABC.jpg
 *   _ref?: string
 *   storageKey?: string
 *   asset?: { url?: string; _ref?: string }
 *   width?: number
 *   height?: number
 *   displayWidth?: number
 *   displayHeight?: number
 * }
 * ```
 *
 * The media-library object is resolved by `readMediaLibraryFileUrl` (same field order as
 * other library rows, including `{ id: "<storageKey>.jpg" }`). The string then goes through
 * EmDash `sanitizeHref`. A poster is kept only when that result is an EmDash media image
 * (`/_emdash/api/media/file/<storageKey>.(jpg|jpeg|png|webp)`) or an `https` URL.
 *
 * When a poster resolves, the player reserves a box: numeric width and height from the
 * poster object, or 16 / 9 when the value has no dimensions. `preload="none"` is only
 * used together with that reserved ratio. Without a poster, preload stays `metadata`.
 */

import { sanitizeHref } from 'emdash';
import {
	normalizeToPublicMediaFilePath,
	readMediaLibraryFileUrl,
} from './mediaFileUrl';

const POSTER_MEDIA_PATH = /^\/_emdash\/api\/media\/file\/[A-Za-z0-9]+\.(jpe?g|png|webp)$/i;

/** Reserved box when a resolved poster has no numeric width and height. */
export const VIDEO_POSTER_FALLBACK_WIDTH = 16;
export const VIDEO_POSTER_FALLBACK_HEIGHT = 9;

export type ResolvedVideoPoster = {
	src: string;
	width: number;
	height: number;
	/** CSS `aspect-ratio` value, for example `16 / 9` or `1920 / 1080`. */
	aspectRatio: string;
};

function readPositiveNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** File dimensions on a video block: integers of at least 1, matching core `Video`. */
function readBlockDimension(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function readPosterDimensions(
	record: Record<string, unknown>,
	depth: number,
): { width: number; height: number } | null {
	if (depth > 3) return null;
	const width = readPositiveNumber(record.displayWidth) ?? readPositiveNumber(record.width);
	const height = readPositiveNumber(record.displayHeight) ?? readPositiveNumber(record.height);
	if (width != null && height != null) return { width, height };
	const asset = record.asset;
	if (asset && typeof asset === 'object' && !Array.isArray(asset)) {
		return readPosterDimensions(asset as Record<string, unknown>, depth + 1);
	}
	return null;
}

function toPosterCandidate(value: string): string {
	const trimmed = value.trim();
	const normalized = normalizeToPublicMediaFilePath(trimmed);
	if (!normalized) return trimmed;
	return normalized.split('?')[0]?.split('#')[0] ?? normalized;
}

function posterCandidateFromValue(raw: unknown, depth: number): string | null {
	if (depth > 3) return null;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		return trimmed ? toPosterCandidate(trimmed) : null;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const direct = readMediaLibraryFileUrl(record);
	if (direct) return toPosterCandidate(direct);
	const asset = record.asset;
	if (asset && typeof asset === 'object' && !Array.isArray(asset)) {
		return posterCandidateFromValue(asset, depth + 1);
	}
	return null;
}

function acceptSanitizedPoster(safe: string): string | null {
	if (POSTER_MEDIA_PATH.test(safe)) return safe;
	if (!/^https:\/\//i.test(safe)) return null;
	try {
		const parsed = new URL(safe);
		if (parsed.protocol !== 'https:') return null;
		if (POSTER_MEDIA_PATH.test(parsed.pathname)) return parsed.pathname;
		return safe;
	} catch {
		return null;
	}
}

function posterBox(raw: unknown): { width: number; height: number } {
	const fromObject =
		raw && typeof raw === 'object' && !Array.isArray(raw)
			? readPosterDimensions(raw as Record<string, unknown>, 0)
			: null;
	const width = fromObject?.width ?? VIDEO_POSTER_FALLBACK_WIDTH;
	const height = fromObject?.height ?? VIDEO_POSTER_FALLBACK_HEIGHT;
	return { width, height };
}

/**
 * Optional holding image for the self-hosted player.
 * Returns null when the value is missing, `http`, or not an image media path or `https` URL.
 */
export function resolveVideoPoster(node: Record<string, unknown>): ResolvedVideoPoster | null {
	const raw = node.poster;
	const candidate = posterCandidateFromValue(raw, 0);
	if (!candidate) return null;
	const safe = sanitizeHref(candidate);
	if (safe !== candidate) return null;
	const src = acceptSanitizedPoster(safe);
	if (!src) return null;
	const { width, height } = posterBox(raw);
	return {
		src,
		width,
		height,
		aspectRatio: `${width} / ${height}`,
	};
}

/** `none` only when a poster will be rendered; otherwise the historical `metadata`. */
export function selfHostedVideoPreload(
	poster: ResolvedVideoPoster | null,
): 'none' | 'metadata' {
	return poster ? 'none' : 'metadata';
}

/**
 * Box reserved for a self-hosted player.
 * EmDash 1.2.0 stores integer `width` and `height` on the video block itself.
 * Those win over the poster image, because they are the file's dimensions.
 * A poster with no block dimensions uses the poster box (or 16 / 9).
 * No poster and no block dimensions leaves the box to file metadata.
 */
export function resolveSelfHostedVideoFrame(
	node: Record<string, unknown>,
	poster: ResolvedVideoPoster | null,
): { width: number; height: number; aspectRatio: string } | null {
	const width = readBlockDimension(node.width);
	const height = readBlockDimension(node.height);
	if (width != null && height != null) {
		return { width, height, aspectRatio: `${width} / ${height}` };
	}
	if (!poster) return null;
	return { width: poster.width, height: poster.height, aspectRatio: poster.aspectRatio };
}
