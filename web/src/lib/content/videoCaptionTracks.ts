/**
 * Resolve WebVTT sidecar track(s) for a self-hosted `_type: "embed"` + `provider: "video"` node.
 *
 * EmDash posts schema has no captions field. Extra Portable Text keys below are stored if
 * sent via MCP / content_update. Prefer node fields over a hardcoded map so a burned-in MP4
 * is never paired with VTT (double captions).
 *
 * ## Portable Text embed extras (Freedom Times)
 *
 * ```ts
 * // Legacy (still supported):
 * captionsUrl?: string
 *
 * // Multi-track:
 * captions?: Array<{
 *   url: string
 *   srclang: string   // e.g. "en"
 *   label: string     // e.g. "English"
 *   default?: boolean // preferred track when captions are default-on
 * }>
 * captionsDefaultOn?: boolean
 * // true / omitted → emit `default` on exactly one <track> (browser shows CC on)
 * // false → emit all <track>s but no `default` (CC menu available; starts off)
 * ```
 *
 * Authors (MCP): set these on the embed node alongside `url` (or `id`) + `provider: "video"`.
 * The EmDash editor stores the MP4 path on `id`; the reader accepts either field.
 * Relative `/_emdash/api/media/file/<id>.vtt` paths are kept as-is after sanitize.
 */

const EMDASH_MEDIA_FILE = /^\/_emdash\/api\/media\/file\/[A-Za-z0-9]+\.(vtt|mp4)$/i;

export type VideoCaptionTrackInput = {
	url: string;
	srclang: string;
	label: string;
	default?: boolean;
};

/** Sanitized track ready for `<track kind="captions" …>`. */
export type ResolvedVideoCaptionTrack = {
	src: string;
	srclang: string;
	label: string;
	/** When true, render the HTML `default` attribute on this track only. */
	isDefault: boolean;
};

function readString(input: unknown): string | null {
	return typeof input === 'string' && input.trim().length > 0 ? input.trim() : null;
}

function readBoolean(input: unknown): boolean | undefined {
	return typeof input === 'boolean' ? input : undefined;
}

export function normalizeMediaPath(url: string): string {
	const trimmed = url.trim();
	if (trimmed.startsWith('/')) return trimmed.split('?')[0] ?? trimmed;
	try {
		const parsed = new URL(trimmed);
		return parsed.pathname;
	} catch {
		return trimmed;
	}
}

export function sanitizeCaptionsUrl(url: string): string | null {
	const path = normalizeMediaPath(url);
	if (EMDASH_MEDIA_FILE.test(path) && path.toLowerCase().endsWith('.vtt')) {
		return path;
	}
	return null;
}

/**
 * Self-hosted video src for `_type: "embed"` + `provider: "video"`.
 * Prefer `url`; fall back to `id` when the editor stored the media-file path there.
 */
export function resolveSelfHostedVideoUrl(node: Record<string, unknown>): string | null {
	const url = readString(node.url);
	if (url) return url;
	const id = readString(node.id);
	if (!id) return null;
	const path = normalizeMediaPath(id);
	if (path.startsWith('/_emdash/api/media/file/')) return path;
	return null;
}

/**
 * Known video → VTT pairs. Leave empty unless the mp4 on that URL is unburned.
 * Example (after Admin / CLI upload of the unburned file):
 *   '/_emdash/api/media/file/<mp4-key>.mp4': '/_emdash/api/media/file/<vtt-key>.vtt'
 */
export const VIDEO_CAPTION_TRACKS: Readonly<Record<string, string>> = {};

function normalizeCaptionTrack(raw: unknown): Omit<ResolvedVideoCaptionTrack, 'isDefault'> | null {
	if (!raw || typeof raw !== 'object') return null;
	const rec = raw as Record<string, unknown>;
	const url = readString(rec.url) ?? readString(rec.src);
	if (!url) return null;
	const src = sanitizeCaptionsUrl(url);
	if (!src) return null;
	const srclang = readString(rec.srclang) ?? readString(rec.lang) ?? 'en';
	const label = readString(rec.label) ?? srclang;
	return { src, srclang, label };
}

function tracksWantDefault(rawTracks: unknown[]): boolean {
	return rawTracks.some((t) => {
		if (!t || typeof t !== 'object') return false;
		return (t as Record<string, unknown>).default === true;
	});
}

/**
 * Parse legacy + multi-track caption fields from a PT embed node.
 * Returns tracks with at most one `isDefault: true` when captions should start on.
 */
export function resolveVideoCaptionTracks(
	node: Record<string, unknown>,
	videoUrl: string,
): ResolvedVideoCaptionTrack[] {
	const captionsDefaultOn = readBoolean(node.captionsDefaultOn);
	const rawList: unknown[] = [];
	let fromLegacySingle = false;

	if (Array.isArray(node.captions) && node.captions.length > 0) {
		rawList.push(...node.captions);
	} else {
		// Legacy string URL on captionsUrl / captions, or hardcoded map.
		const legacyUrl =
			readString(node.captionsUrl)
			?? (typeof node.captions === 'string' ? readString(node.captions) : null)
			?? (Array.isArray(node.tracks)
				? readString((node.tracks[0] as Record<string, unknown> | undefined)?.src)
					?? readString((node.tracks[0] as Record<string, unknown> | undefined)?.url)
				: null);

		if (legacyUrl) {
			rawList.push({
				url: legacyUrl,
				srclang: 'en',
				label: 'English',
				default: true,
			});
			fromLegacySingle = true;
		} else if (Array.isArray(node.tracks) && node.tracks.length > 0) {
			rawList.push(...node.tracks);
		} else {
			const mapped = VIDEO_CAPTION_TRACKS[normalizeMediaPath(videoUrl)];
			if (mapped) {
				rawList.push({
					url: mapped,
					srclang: 'en',
					label: 'English',
					default: true,
				});
				fromLegacySingle = true;
			}
		}
	}

	const normalized: Array<Omit<ResolvedVideoCaptionTrack, 'isDefault'> & { preferDefault: boolean }> =
		[];
	const seen = new Set<string>();
	for (const raw of rawList) {
		const track = normalizeCaptionTrack(raw);
		if (!track) continue;
		const key = `${track.src}\0${track.srclang}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const preferDefault =
			!!raw && typeof raw === 'object' && (raw as Record<string, unknown>).default === true;
		normalized.push({ ...track, preferDefault });
	}

	if (normalized.length === 0) return [];

	const enableDefault =
		captionsDefaultOn === false
			? false
			: captionsDefaultOn === true
				|| fromLegacySingle
				|| tracksWantDefault(rawList)
				|| normalized.some((t) => t.preferDefault);

	let defaultIndex = -1;
	if (enableDefault) {
		defaultIndex = normalized.findIndex((t) => t.preferDefault);
		if (defaultIndex < 0) defaultIndex = 0;
	}

	return normalized.map(({ preferDefault: _p, ...track }, i) => ({
		...track,
		isDefault: i === defaultIndex,
	}));
}

/** @deprecated Prefer `resolveVideoCaptionTracks`. Returns the first track src, if any. */
export function resolveVideoCaptionsUrl(
	node: Record<string, unknown>,
	videoUrl: string,
): string | null {
	const tracks = resolveVideoCaptionTracks(node, videoUrl);
	return tracks[0]?.src ?? null;
}
