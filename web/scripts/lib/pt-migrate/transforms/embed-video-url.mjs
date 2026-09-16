/**
 * Copy a media-file path from embed.id onto embed.url for self-hosted video.
 * The EmDash editor often stores the MP4 on `id` and drops `url`; older Workers
 * only rendered `url`. Captions extras are left untouched.
 */

function readString(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function mediaFilePath(value) {
	const raw = readString(value);
	if (!raw) return null;
	if (raw.startsWith('/_emdash/api/media/file/')) {
		return raw.split('?')[0] ?? raw;
	}
	try {
		const parsed = new URL(raw);
		if (parsed.pathname.startsWith('/_emdash/api/media/file/')) return parsed.pathname;
	} catch {
		/* ignore */
	}
	return null;
}

export function transformEmbedVideoUrlBlock(block, index) {
	if (!block || block._type !== 'embed' || block.provider !== 'video') {
		return { block, change: null };
	}
	if (mediaFilePath(block.url)) {
		return { block, change: null };
	}
	const fromId = mediaFilePath(block.id);
	if (!fromId) {
		return { block, change: null };
	}
	const after = { ...block, url: fromId };
	return {
		block: after,
		change: {
			index,
			transform: 'embed-video-url',
			kind: 'copy-id-to-url',
			before: { _type: 'embed', id: block.id ?? null, url: block.url ?? null },
			after: { _type: 'embed', id: after.id ?? null, url: after.url },
		},
	};
}

export const embedVideoUrlTransform = {
	id: 'embed-video-url',
	description:
		'Self-hosted embed+provider:video: copy media-file path from id onto url (keep captions extras)',
	/** @param {unknown} block */
	matches(block) {
		if (!block || typeof block !== 'object') return false;
		const rec = /** @type {Record<string, unknown>} */ (block);
		if (rec._type !== 'embed' || rec.provider !== 'video') return false;
		if (mediaFilePath(rec.url)) return false;
		return Boolean(mediaFilePath(rec.id));
	},
	transform: transformEmbedVideoUrlBlock,
};
