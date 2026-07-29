import { videoTransform } from './video.mjs';

/** @typedef {typeof videoTransform} PtTransform */

/** Registry of content transforms. Add new migrations here as we expand. */
export const TRANSFORMS = {
	video: videoTransform,
};

export function listTransforms() {
	return Object.values(TRANSFORMS).map((t) => ({
		id: t.id,
		description: t.description,
	}));
}

/**
 * @param {string[]} ids
 * @returns {PtTransform[]}
 */
export function resolveTransforms(ids) {
	const list = ids.length > 0 ? ids : Object.keys(TRANSFORMS);
	const out = [];
	for (const id of list) {
		const t = TRANSFORMS[id];
		if (!t) {
			throw new Error(`Unknown transform "${id}". Known: ${Object.keys(TRANSFORMS).join(', ')}`);
		}
		out.push(t);
	}
	return out;
}

/**
 * Apply selected transforms to a Portable Text content array.
 * @param {unknown[]} content
 * @param {PtTransform[]} transforms
 */
export function applyTransforms(content, transforms) {
	/** @type {object[]} */
	const changes = [];
	if (!Array.isArray(content)) {
		return { content, changes, stats: { blocks: 0, changed: 0 } };
	}

	const next = content.map((block, index) => {
		let current = block;
		for (const t of transforms) {
			if (!t.matches(current)) continue;
			const { block: migrated, change } = t.transform(current, index);
			current = migrated;
			if (change) changes.push(change);
		}
		return current;
	});

	const stats = {
		blocks: content.length,
		changed: changes.length,
		byKind: {},
	};
	for (const c of changes) {
		const key = `${c.transform}:${c.kind}`;
		stats.byKind[key] = (stats.byKind[key] || 0) + 1;
	}

	return { content: next, changes, stats };
}
