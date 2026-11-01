/**
 * Hashtags for an X or Bluesky post. #Cult is always first. Each name in the
 * post's organisations field becomes one tag, in that order, dropped from the
 * end when the headline and the link leave no room.
 */
import { graphemeLength } from './policy';
import { X_MAX_WEIGHTED_LENGTH, xWeightedLength } from './x';

export const HOUSE_HASHTAG = '#Cult';
const BLUESKY_MAX = 300;
const SEPARATOR = '\n\n';

/** `#InternationalShekinahGlory` from "International Shekinah Glory". */
export function hashtagFromName(name: string): string | null {
	const words = name
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/['’]/g, '')
		.replace(/[^A-Za-z0-9]+/g, ' ')
		.trim()
		.split(/\s+/)
		.filter((word) => word.length > 0);
	if (words.length === 0) return null;
	const body = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
	if (!body || body.toLowerCase() === 'cult') return null;
	return `#${body}`;
}

function composed(title: string, url: string, hashtags: string): string {
	const head = title ? `${title}${SEPARATOR}${url}` : url;
	return `${head}${SEPARATOR}${hashtags}`;
}

function fitsBoth(title: string, url: string, hashtags: string): boolean {
	const text = composed(title, url, hashtags);
	return graphemeLength(text) <= BLUESKY_MAX && xWeightedLength(text) <= X_MAX_WEIGHTED_LENGTH;
}

/** The hashtag line both networks use, so the posts match. */
export function socialHashtagLine(title: string, url: string, groups: readonly string[]): string {
	const tags = [HOUSE_HASHTAG];
	const seen = new Set(['cult']);
	for (const name of groups) {
		const tag = hashtagFromName(name);
		if (!tag) continue;
		const key = tag.slice(1).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		tags.push(tag);
	}
	while (tags.length > 1 && !fitsBoth(title.trim(), url, tags.join(' '))) tags.pop();
	return tags.join(' ');
}
