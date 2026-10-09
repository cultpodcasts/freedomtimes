/**
 * One playback value for both stored self-hosted shapes.
 *
 * `VideoWithCaptions` renders `{ kind: "player" }`. `EmbedWithCaptions` mounts
 * that same component when `provider` is `"video"`.
 *
 * Local shapes that become a player:
 * - EmDash 1.2.0 `_type: "video"` with `asset.url` (provider absent or `"local"`)
 * - Older `_type: "embed"` + `provider: "video"` (`url`, or `id` when it is a
 *   media-file `.mp4`)
 *
 * A provider other than `"local"` is `{ kind: "core" }` with only the fields
 * core `Video` accepts (`_type`, `_key`, `asset`, `caption`, `width`, `height`).
 * Poster and WebVTT stay off that node, because they make `isPortableTextVideoBlock`
 * fail. Local `getEmbed` does not set `poster`.
 *
 * A refused URL or an empty block is `{ kind: "none" }` and renders nothing.
 * Integer `width` / `height` on the node are the file dimensions and win the
 * reserved box over the poster image.
 */

import { sanitizeHref } from 'emdash';
import {
	EMDASH_MEDIA_FILE,
	normalizeMediaPath,
	resolveVideoCaptionTracks,
	type ResolvedVideoCaptionTrack,
} from './videoCaptionTracks';
import {
	resolveSelfHostedVideoFrame,
	resolveVideoPoster,
	selfHostedVideoPreload,
	type ResolvedVideoPoster,
} from './videoPoster';

function readString(input: unknown): string | null {
	return typeof input === 'string' && input.trim().length > 0 ? input.trim() : null;
}

function isEmDashMp4Path(path: string): boolean {
	return EMDASH_MEDIA_FILE.test(path) && path.toLowerCase().endsWith('.mp4');
}

/**
 * After `sanitizeHref`, a playable src is the mp4 arm of `EMDASH_MEDIA_FILE`
 * or an `https` URL. The `#` sentinel, `http:`, `mailto:`, `tel:`, `.vtt`,
 * and other site paths are not video sources.
 */
function acceptSanitizedVideoSrc(safe: string): string | null {
	const path = normalizeMediaPath(safe);
	if (isEmDashMp4Path(path)) return path;
	if (!/^https:\/\//i.test(safe)) return null;
	try {
		const parsed = new URL(safe);
		if (parsed.protocol !== 'https:') return null;
		return safe;
	} catch {
		return null;
	}
}

/**
 * Self-hosted video src for `_type: "embed"` + `provider: "video"`.
 * Prefer `url`; fall back to `id` when the editor stored the media-file path there.
 * Both branches refuse anything that is not an EmDash `.mp4` path or an `https` URL.
 */
export function resolveSelfHostedVideoUrl(node: Record<string, unknown>): string | null {
	const url = readString(node.url);
	if (url) return acceptSanitizedVideoSrc(sanitizeHref(url));
	const id = readString(node.id);
	if (!id) return null;
	const path = normalizeMediaPath(id);
	if (!isEmDashMp4Path(path)) return null;
	return acceptSanitizedVideoSrc(sanitizeHref(path));
}

function readAssetRecord(node: Record<string, unknown>): Record<string, unknown> | null {
	const asset = node.asset;
	if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return null;
	return asset as Record<string, unknown>;
}

/** Provider id that core `Video` plays through `getEmbed`. `"local"` is a file. */
function readEmbedProvider(asset: Record<string, unknown> | null): string | null {
	if (!asset) return null;
	const provider = readString(asset.provider);
	if (!provider || provider === 'local') return null;
	return provider;
}

/** Integers core `Video` accepts on `width` / `height` (`isPortableTextVideoBlock`). */
function isCoreDimension(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Playable local file for an EmDash 1.2.0 `_type: "video"` block.
 * The editor stores the file on `asset.url`. `_ref` is the media id and is not a file URL.
 * An `https` URL is local only when `asset.provider` is absent or `"local"`.
 * A provider other than `"local"` is not a local mp4, even when `asset.url` is `https`.
 */
export function resolveVideoBlockSrc(node: Record<string, unknown>): string | null {
	const asset = readAssetRecord(node);
	if (!asset) return null;
	if (readEmbedProvider(asset)) return null;
	const url = readString(asset.url);
	if (!url) return null;
	return acceptSanitizedVideoSrc(sanitizeHref(url));
}

/** Built-in fields core `Video` accepts. Extras such as `poster` and WebVTT are omitted. */
export type VideoBlockCoreNode = {
	_type: 'video';
	_key: string;
	asset?: {
		_ref: string;
		url?: string;
		provider?: string;
	};
	caption?: string;
	width?: number;
	height?: number;
};

export type SelfHostedPlayerPlayback = {
	kind: 'player';
	src: string;
	caption: string | null;
	tracks: ResolvedVideoCaptionTrack[];
	poster: ResolvedVideoPoster | null;
	frame: { width: number; height: number; aspectRatio: string } | null;
	preload: 'none' | 'metadata';
};

export type StoredVideoPlayback =
	| SelfHostedPlayerPlayback
	| { kind: 'core'; node: VideoBlockCoreNode }
	| { kind: 'none' };

function coreNodeForProvider(
	node: Record<string, unknown>,
	asset: Record<string, unknown>,
	provider: string,
): VideoBlockCoreNode {
	const core: VideoBlockCoreNode = {
		_type: 'video',
		_key: readString(node._key) ?? 'video',
	};
	const ref = readString(asset._ref);
	if (ref) {
		const url = readString(asset.url);
		core.asset = url ? { _ref: ref, url, provider } : { _ref: ref, provider };
	}
	const caption = readString(node.caption);
	if (caption) core.caption = caption;
	if (isCoreDimension(node.width)) core.width = node.width;
	if (isCoreDimension(node.height)) core.height = node.height;
	return core;
}

function buildPlayer(node: Record<string, unknown>, src: string): SelfHostedPlayerPlayback {
	const poster = resolveVideoPoster(node);
	return {
		kind: 'player',
		src,
		caption: readString(node.caption),
		tracks: resolveVideoCaptionTracks(node, src),
		poster,
		frame: resolveSelfHostedVideoFrame(node, poster),
		preload: selfHostedVideoPreload(poster),
	};
}

/**
 * Which render a stored video node needs.
 * A local 1.2.0 block and a legacy `provider: "video"` embed share one player value.
 * Any other provider on a video block goes to core `Video`.
 */
export function resolveStoredVideoPlayback(node: Record<string, unknown>): StoredVideoPlayback {
	if (node._type === 'video') {
		const asset = readAssetRecord(node);
		const provider = readEmbedProvider(asset);
		if (provider && asset) {
			return { kind: 'core', node: coreNodeForProvider(node, asset, provider) };
		}
		const src = resolveVideoBlockSrc(node);
		if (src) return buildPlayer(node, src);
		return { kind: 'none' };
	}
	if (readString(node.provider) === 'video') {
		const src = resolveSelfHostedVideoUrl(node);
		if (src) return buildPlayer(node, src);
		return { kind: 'none' };
	}
	return { kind: 'none' };
}
