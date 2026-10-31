/**
 * Shared rules for the admin-only "Post to …" social share panels
 * (src/plugins/social-share.ts, web/docs/SOCIAL_SHARING.md).
 *
 * Pure functions only (no Astro / Worker / EmDash imports) so
 * scripts/test-social-share.mts can test them directly.
 */
import { isProductionPublicHostname } from '../homepage-host';
import { contentCanonicalPath } from '../seo/article-seo';

/** EmDash RBAC level for Admin (@emdash-cms/auth Role.ADMIN). */
export const EMDASH_ADMIN_ROLE = 50;

/** Public origin every shared link points at (production only ever posts). */
export const PRODUCTION_SITE_ORIGIN = 'https://freedomtimes.news';

/** Only the `posts` collection can be shared. */
export const SHAREABLE_COLLECTION = 'posts';

/**
 * Sharing only works on the production Worker serving a production public
 * host. Staging (`SITE_ACCESS_MODE=locked`, staging.freedomtimes.news),
 * local dev and preview hosts can never post to the real accounts.
 */
export function isSocialShareEnvironment(input: { siteAccessMode?: unknown; hostname: string }): boolean {
	const mode = typeof input.siteAccessMode === 'string' ? input.siteAccessMode.trim().toLowerCase() : '';
	return mode === 'public' && isProductionPublicHostname(input.hostname);
}

/** Absolute public article URL for a post slug. */
export function articleUrl(slug: string): string {
	return `${PRODUCTION_SITE_ORIGIN}${contentCanonicalPath(SHAREABLE_COLLECTION, slug)}`;
}

/** Plugin KV key holding the share record for one network and post. */
export function shareRecordKey(network: string, postId: string): string {
	return `share:${network}:${postId}`;
}

/** A trimmed non-empty string, or undefined. */
export function readSecret(env: Record<string, unknown>, name: string): string | undefined {
	const value = env[name];
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Number of user-perceived characters (graphemes). */
export function graphemeLength(text: string): number {
	let n = 0;
	for (const _ of segmenter.segment(text)) n++;
	return n;
}

/** Cut to at most `max` graphemes, ending with an ellipsis when cut. */
export function truncateGraphemes(text: string, max: number): string {
	if (max <= 0) return '';
	if (graphemeLength(text) <= max) return text;
	const out: string[] = [];
	for (const { segment } of segmenter.segment(text)) {
		if (out.length >= max - 1) break;
		out.push(segment);
	}
	return `${out.join('').trimEnd()}…`;
}

function str(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const t = value.replace(/\s+/g, ' ').trim();
	return t.length > 0 ? t : undefined;
}

/** What a share needs from an EmDash post. */
export interface SharePostSnapshot {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	description: string;
}

/**
 * Title and description the same way the article page picks og:title and
 * og:description (social_title → SEO title → title; SEO description → lede).
 */
export function snapshotFromContentItem(item: {
	id: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	seo?: { title?: string | null; description?: string | null } | null;
}): SharePostSnapshot {
	const data = item.data ?? {};
	const title = str(data.social_title) ?? str(item.seo?.title) ?? str(data.title) ?? '';
	const description = str(item.seo?.description) ?? str(data.lede) ?? str(data.excerpt) ?? '';
	return { id: item.id, slug: item.slug, status: item.status, title, description };
}

/** Short stable fingerprint of the preview, so a stale confirm can't post changed text. */
export async function previewFingerprint(parts: string[]): Promise<string> {
	const bytes = new TextEncoder().encode(parts.join('\u0000'));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest).slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Failure while sharing. `definitelyNotPosted` is true when the network
 * rejected the request before a post could exist (bad credentials, a 4xx
 * on the create call), so the double-post lock can be released automatically.
 */
export class ShareNetworkError extends Error {
	readonly definitelyNotPosted: boolean;
	constructor(message: string, definitelyNotPosted: boolean) {
		super(message);
		this.name = 'ShareNetworkError';
		this.definitelyNotPosted = definitelyNotPosted;
	}
}

export interface SharedPost {
	/** Network id of the new post (at:// URI or tweet id). */
	id: string;
	/** Public web URL of the new post. */
	url: string;
}
