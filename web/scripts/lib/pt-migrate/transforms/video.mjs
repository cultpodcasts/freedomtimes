/**
 * Pluggable Portable Text block transforms for staging content migration.
 * Add a new file under transforms/ and register it in index.mjs.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{6,}$/;

function youtubeIdFromUrl(url) {
	try {
		const u = new URL(url);
		const host = u.hostname.toLowerCase().replace(/^www\./, '');
		if (host === 'youtu.be') {
			const id = u.pathname.split('/').filter(Boolean)[0] ?? '';
			return YOUTUBE_ID.test(id) ? id : null;
		}
		const isYoutube =
			host === 'youtube.com' ||
			host === 'm.youtube.com' ||
			host === 'youtube-nocookie.com';
		if (!isYoutube) return null;
		const v = u.searchParams.get('v');
		if (v && YOUTUBE_ID.test(v)) return v;
		const parts = u.pathname.split('/').filter(Boolean);
		if (parts[0] === 'embed' && parts[1] && YOUTUBE_ID.test(parts[1])) return parts[1];
		if (parts[0] === 'shorts' && parts[1] && YOUTUBE_ID.test(parts[1])) return parts[1];
		return null;
	} catch {
		return null;
	}
}

function resolveVideoSrc(block) {
	const candidates = [
		block.url,
		block.id,
		block.file,
		block.asset && typeof block.asset === 'object' ? block.asset.url : null,
		block.asset && typeof block.asset === 'object' ? block.asset._ref : null,
	];
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim()) return c.trim();
	}
	return null;
}

function toMediaFileUrl(src) {
	if (!src) return null;
	if (src.startsWith('/_emdash/api/media/file/')) return src;
	if (src.startsWith('http://') || src.startsWith('https://')) {
		try {
			const u = new URL(src);
			if (u.pathname.startsWith('/_emdash/api/media/file/')) return u.pathname;
		} catch {
			/* ignore */
		}
		return src;
	}
	if (/^[0-9A-HJKMNP-TV-Z]{26}/i.test(src) || src.includes('.')) {
		return `/_emdash/api/media/file/${src}`;
	}
	return src;
}

function hasText(value) {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 * An EmDash 1.2.0 editor video: `asset` carries `_ref` or `url`, and the node
 * has no legacy top-level `url` / `id` / `file`. Those blocks stay video blocks.
 */
function isEditorVideoBlock(block) {
	const asset = block.asset;
	if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
	if (!hasText(asset._ref) && !hasText(asset.url)) return false;
	if (hasText(block.url) || hasText(block.id) || hasText(block.file)) return false;
	return true;
}

/**
 * Legacy FT `_type: "video"` with top-level `url` / `id` / `file` → plugin `youtube`
 * or core `embed`+provider video. An editor video block is returned unchanged.
 * @returns {{ block: object, change: object | null }}
 */
export function transformVideoBlock(block, index) {
	if (!block || block._type !== 'video') {
		return { block, change: null };
	}
	if (isEditorVideoBlock(block)) {
		return { block, change: null };
	}
	const src = resolveVideoSrc(block);
	if (!src) {
		return {
			block,
			change: {
				index,
				transform: 'video',
				kind: 'unresolved',
				before: block,
				after: block,
				note: 'No url/id/file/asset on video block',
			},
		};
	}

	const ytId = youtubeIdFromUrl(src);
	if (ytId) {
		// EmDash plugin-embeds / lite-youtube expect a bare video id, not a watch/embed URL.
		const after = {
			_type: 'youtube',
			id: ytId,
		};
		if (typeof block._key === 'string' && block._key) after._key = block._key;
		if (typeof block.alt === 'string' && block.alt.trim()) after.title = block.alt.trim();
		return {
			block: after,
			change: {
				index,
				transform: 'video',
				kind: 'youtube',
				before: { _type: 'video', src, alt: block.alt ?? null },
				after: { _type: 'youtube', id: after.id, title: after.title ?? null },
			},
		};
	}

	const url = toMediaFileUrl(src);
	const after = {
		_type: 'embed',
		url,
		provider: 'video',
	};
	if (typeof block._key === 'string' && block._key) after._key = block._key;
	if (typeof block.alt === 'string' && block.alt.trim()) after.caption = block.alt.trim();
	return {
		block: after,
		change: {
			index,
			transform: 'video',
			kind: 'embed',
			before: { _type: 'video', src, alt: block.alt ?? null },
			after: { _type: 'embed', url, provider: 'video', caption: after.caption ?? null },
		},
	};
}

export const videoTransform = {
	id: 'video',
	description:
		'Legacy FT video with url/id/file → youtube or embed+provider:video. Editor video blocks (asset._ref or asset.url, no top-level url/id/file) are left unchanged.',
	/** @param {unknown} block */
	matches(block) {
		return Boolean(block && typeof block === 'object' && block._type === 'video');
	},
	transform: transformVideoBlock,
};
