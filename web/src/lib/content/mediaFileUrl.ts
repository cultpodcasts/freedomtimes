/**
 * Public EmDash media-file paths.
 *
 * Public file URLs are only `/_emdash/api/media/file/<storageKey>` where `storageKey` is the
 * R2 object name (EmDash uses e.g. `<ulid>.png`). Media row `id` is different and returns 404 if
 * used as `key` (see emdash `addUrlToMedia` / `storage.download(key)`).
 * Storage keys in this project include a file extension; bare ULIDs are media ids, not keys.
 */

function readString(value: unknown): string | null {
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

export function normalizeToPublicMediaFilePath(value: string): string | null {
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
	if (/\.[a-z0-9]{2,5}$/i.test(trimmed) && !trimmed.includes('/')) {
		return `/_emdash/api/media/file/${trimmed}`;
	}
	return null;
}

/**
 * Resolve a media-library value to a URL string or a public file path.
 * Strings are returned trimmed (callers decide whether to normalise).
 * Objects prefer `url` / `src` / `file` / `path` / `href`, then a storage key,
 * then `id` or `_ref` when that field already has a file extension.
 */
export function readMediaLibraryFileUrl(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return null;
		}

		const parsed = tryParseJsonString(trimmed);
		if (parsed && parsed !== value) {
			return readMediaLibraryFileUrl(parsed);
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
