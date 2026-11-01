/**
 * Hashtags for an X or Bluesky post. #Cult is always first. Each name in the
 * post's organisations field becomes one tag, in that order. A tag that does
 * not fit is skipped so a shorter later tag can still use the room. Each
 * network passes its own length function, so X can carry more tags than Bluesky.
 */
export const HOUSE_HASHTAG = '#Cult';
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

/** Title, blank line, hashtags, blank line, URL. The URL is last. */
export function composeSocialText(title: string, hashtags: string, url: string): string {
	return [title, hashtags, url].filter((part) => part.length > 0).join(SEPARATOR);
}

/** #Cult, then one tag per organisation name, duplicates removed. */
export function organisationHashtags(groups: readonly string[]): string[] {
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
	return tags;
}

/**
 * The hashtag line for one network. Tags are kept in order. A tag that would
 * push the title, the line and the URL over `max` is skipped.
 */
export function socialHashtagLine(
	title: string,
	url: string,
	groups: readonly string[],
	length: (text: string) => number,
	max: number,
): string {
	const kept: string[] = [];
	for (const tag of organisationHashtags(groups)) {
		const next = [...kept, tag].join(' ');
		if (length(composeSocialText(title.trim(), next, url)) <= max) kept.push(tag);
	}
	return kept.length > 0 ? kept.join(' ') : HOUSE_HASHTAG;
}
