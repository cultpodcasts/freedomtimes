/**
 * Pure readers for EmDash media/image field values (`ImageValue` / `MediaValue` in EmDash 1.3.1:
 * `{ id, provider, alt?, caption?, meta?: { storageKey, … }, … }`), shared by the hero image,
 * alt and caption readers. No `cloudflare:` / env imports, so tsx tests can load it.
 */
import { normalizeToPublicMediaFilePath } from './mediaFileUrl';

/** Non-blank string, trimmed; otherwise `null`. */
export function readTrimmedString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Non-blank string returned as stored (not trimmed). Used where existing src output must not change. */
function readNonBlankString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
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
 * A media value as a plain record: an object, or a string holding a JSON object (some stored
 * values arrive JSON-encoded). Arrays, scalars and invalid JSON give `null`.
 */
export function asMediaRecord(value: unknown): Record<string, unknown> | null {
	const candidate = typeof value === 'string' ? tryParseJsonString(value) : value;
	return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
		? (candidate as Record<string, unknown>)
		: null;
}

/**
 * Public src for an image field value: `meta.storageKey` (→ `/_emdash/api/media/file/<key>`), else
 * `src` / `url`, else a plain string path/URL. JSON-string values are parsed first. `null` when the
 * value has no file (e.g. only `alt`).
 */
export function readMediaValueSrc(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return null;
		}
		const parsed = tryParseJsonString(trimmed);
		if (parsed && typeof parsed === 'object' && parsed !== null) {
			return readMediaValueSrc(parsed);
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
			readNonBlankString(meta?.storageKey)
			?? readNonBlankString(meta?.storage_key)
			?? readNonBlankString(candidate.storageKey)
			?? readNonBlankString(candidate.storage_key);
		if (storageKey) {
			return `/_emdash/api/media/file/${storageKey}`;
		}

		const src = readNonBlankString(candidate.src) ?? readNonBlankString(candidate.url);
		if (src) {
			return normalizeToPublicMediaFilePath(src);
		}

		return null;
	}

	return null;
}
