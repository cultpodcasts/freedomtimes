/**
 * Text for an automatic @_freedomtimes post: headline, a short hook, and the
 * article link. X counts every URL as 23 (t.co). The finished text is at most
 * 280 on that scale. The intent link is how Jon posts it by hand until the
 * X API is available.
 */
import { articleUrl } from '../social-share/policy.ts';
import { truncateXWeighted, X_MAX_WEIGHTED_LENGTH, xTextWeight, xWeightedLength } from '../social-share/x.ts';

export const X_INTENT_POST_URL = 'https://x.com/intent/post';
const SEPARATOR = '\n\n';

export interface XAutoDraft {
	/** Exact post text: headline, optional hook, article URL. */
	text: string;
	url: string;
	/** X's weighted length of `text` (every URL counts as 23). */
	weightedLength: number;
	/** Ready-to-send link. Jon opens it and presses Post. Nothing is sent by building this. */
	intentUrl: string;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function assemble(headline: string, hook: string, url: string): string {
	return [headline, hook, url].filter((part) => part.length > 0).join(SEPARATOR);
}

/**
 * Headline, then hook, then the article URL. The hook is shortened first.
 * The headline is shortened only when the hook is already gone. The URL stays
 * whole. Weighted length is at most 280.
 */
export function composeXPost(input: { headline: string; hook: string; url: string }): XAutoDraft {
	const url = input.url.trim();
	let headline = oneLine(input.headline);
	let hook = oneLine(input.hook);
	if (hook === headline) hook = '';

	if (xWeightedLength(assemble(headline, hook, url)) > X_MAX_WEIGHTED_LENGTH) {
		const hookRoom = roomBeside(assemble(headline, '', url));
		hook = hookRoom > 0 ? truncateXWeighted(hook, hookRoom) : '';
	}
	if (xWeightedLength(assemble(headline, hook, url)) > X_MAX_WEIGHTED_LENGTH) {
		hook = '';
		const headlineRoom = roomBeside(url);
		headline = headlineRoom > 0 ? truncateXWeighted(headline, headlineRoom) : '';
	}

	const text = assemble(headline, hook, url) || url;
	return {
		text,
		url,
		weightedLength: xWeightedLength(text),
		intentUrl: intentPostUrl(text),
	};
}

/** Weighted characters left for one more part, including the blank line before it. */
function roomBeside(fixed: string): number {
	if (!fixed) return X_MAX_WEIGHTED_LENGTH;
	return X_MAX_WEIGHTED_LENGTH - xWeightedLength(fixed) - xTextWeight(SEPARATOR);
}

/** `https://x.com/intent/post?text=` plus the URL-encoded post. */
export function intentPostUrl(text: string): string {
	const url = new URL(X_INTENT_POST_URL);
	url.searchParams.set('text', text);
	return url.toString();
}

/** Wall-clock time in Britain, for the email to Jon. */
export function formatLondon(date: Date): string {
	const formatted = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/London',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(date);
	return `${formatted} UK`;
}

export function xAutoArticleUrl(slug: string): string {
	return articleUrl(slug);
}
