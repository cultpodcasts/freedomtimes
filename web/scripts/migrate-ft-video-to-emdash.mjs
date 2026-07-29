/**
 * @deprecated Prefer `node scripts/migrate-pt-content.mjs posts <slug>`
 * Kept for offline JSON transform of content_get dumps.
 *
 * Usage: node scripts/migrate-ft-video-to-emdash.mjs <input.json> <output.json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyTransforms, resolveTransforms } from './lib/pt-migrate/transforms/index.mjs';


export { transformVideoBlock as migrateVideoBlock } from './lib/pt-migrate/transforms/video.mjs';

export function migrateContent(content) {
	const { content: next, changes, stats } = applyTransforms(
		content,
		resolveTransforms(['video']),
	);
	const legacyStats = {
		youtube: 0,
		embed: 0,
		unresolved: 0,
		unchanged: stats.blocks - stats.changed,
	};
	for (const c of changes) {
		if (c.kind === 'youtube') legacyStats.youtube += 1;
		else if (c.kind === 'embed') legacyStats.embed += 1;
		else if (c.kind === 'unresolved') legacyStats.unresolved += 1;
	}
	return { content: next, stats: legacyStats, changes };
}

const [,, inPath, outPath] = process.argv;
if (inPath && outPath) {
	const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
	const content = Array.isArray(raw)
		? raw
		: (raw.data?.content ?? raw.content ?? raw.item?.data?.content);
	const { content: migrated, stats } = migrateContent(content);
	fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify({ content: migrated, stats }, null, 2));
	console.log(JSON.stringify(stats));
}
