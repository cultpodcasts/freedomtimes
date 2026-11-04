/**
 * Shared rules for the admin-only "Post to …" social share panels
 * (src/plugins/social-share.ts, web/docs/SOCIAL_SHARING.md).
 *
 * Pure functions only (no Astro / Worker / EmDash imports) so
 * scripts/test-social-share.mts can test them directly.
 *
 * Card-image *path* resolution is not duplicated here: the plugin calls
 * `readArticleNotificationImagePath` (same contract as article OG /
 * `socialImage.ts`) and passes the absolute URL into
 * {@link snapshotFromContentItem}.
 */
import { isProductionPublicHostname, isStagingHostname, STAGING_HOSTNAME } from '../homepage-host';
import { contentCanonicalPath } from '../seo/article-seo';

/** EmDash RBAC level for Admin (@emdash-cms/auth Role.ADMIN). */
export const EMDASH_ADMIN_ROLE = 50;

/** Public origin every shared link points at (production only ever posts). */
export const PRODUCTION_SITE_ORIGIN = 'https://freedomtimes.news';

/**
 * Hostnames the Worker may fetch for a Bluesky link-card thumb.
 * FT production + staging only — not Bluesky/X API hosts from the plugin sandbox.
 */
export const SHARE_CARD_IMAGE_ALLOWED_HOSTS = [
	new URL(PRODUCTION_SITE_ORIGIN).hostname,
	STAGING_HOSTNAME,
] as const;
/** Only the `posts` collection can be shared. */
export const SHAREABLE_COLLECTION = 'posts';

/**
 * Where the panel runs, which decides what a press of the button does (#178):
 * - `production`: the production Worker (`SITE_ACCESS_MODE=public`) on a
 *   production public host. Posts to the real accounts with the production
 *   secret names. Nothing else can.
 * - `staging`: the locked staging Worker on staging.freedomtimes.news. Posts
 *   only to the TEST accounts, read from the separate `*_TEST_*` secret names;
 *   without them it is a dry run.
 * - `local`: anything else (local dev, previews, unknown hosts). Always a dry
 *   run; no secret is ever read.
 */
export type SocialShareMode = 'production' | 'staging' | 'local';

export function socialShareMode(input: { siteAccessMode?: unknown; hostname: string }): SocialShareMode {
	const mode = typeof input.siteAccessMode === 'string' ? input.siteAccessMode.trim().toLowerCase() : '';
	if (mode === 'public' && isProductionPublicHostname(input.hostname)) return 'production';
	if (mode === 'locked' && isStagingHostname(input.hostname)) return 'staging';
	return 'local';
}

/**
 * Posting to the real accounts only works on the production Worker serving a
 * production public host. Staging posts only to test accounts (or dry-runs);
 * local dev and preview hosts only dry-run.
 */
export function isSocialShareEnvironment(input: { siteAccessMode?: unknown; hostname: string }): boolean {
	return socialShareMode(input) === 'production';
}

/** Absolute public article URL for a post slug. */
export function articleUrl(slug: string): string {
	return `${PRODUCTION_SITE_ORIGIN}${contentCanonicalPath(SHAREABLE_COLLECTION, slug)}`;
}

/**
 * Plugin KV key holding the share record for one network and post. Staging
 * test-account shares use their own prefix, so a production record copied
 * into staging never blocks a test post and a test post is never mistaken for
 * a real one. Dry runs write nothing.
 */
export function shareRecordKey(network: string, postId: string, mode: SocialShareMode = 'production'): string {
	return `${mode === 'production' ? 'share' : 'share-test'}:${network}:${postId}`;
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
	/** Organisation names on the post. Each one becomes a hashtag. */
	groups: string[];
	/**
	 * Absolute URL of the Open Graph / social card image (same resolution as
	 * article `og:image` via `readArticleNotificationImagePath` /
	 * `socialImage.ts`), or null when the post has none / the host is not
	 * allowlisted. Bluesky uploads this as the link-card thumb; X relies on
	 * OG scrape instead.
	 */
	cardImageUrl: string | null;
}

/** True when `hostname` is a Freedom Times origin the Worker may fetch for thumbs. */
export function isAllowedShareCardImageHost(hostname: string): boolean {
	return (SHARE_CARD_IMAGE_ALLOWED_HOSTS as readonly string[]).includes(hostname);
}

/**
 * Absolute card image URL for Worker fetch. Relative paths are joined to
 * `siteOrigin`. Absolute http(s) URLs are kept only when their hostname is in
 * {@link SHARE_CARD_IMAGE_ALLOWED_HOSTS}; anything else returns `null`.
 */
export function absoluteCardImageUrl(pathOrUrl: string, siteOrigin: string): string | null {
	const trimmed = pathOrUrl.trim();
	if (!trimmed) return null;
	let absolute: string;
	if (/^https?:\/\//i.test(trimmed)) {
		absolute = trimmed;
	} else {
		const origin = siteOrigin.replace(/\/$/, '');
		const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
		absolute = `${origin}${path}`;
	}
	try {
		const parsed = new URL(absolute);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		if (!isAllowedShareCardImageHost(parsed.hostname)) return null;
	} catch {
		return null;
	}
	return absolute;
}

/**
 * Title and description the same way the article page picks og:title and
 * og:description (social_title → SEO title → title; SEO description → lede).
 *
 * Pass `cardImageUrl` from the plugin after
 * `readArticleNotificationImagePath` + {@link absoluteCardImageUrl} so the
 * thumb matches article OG (including bare media ids and `_emdash_seo`).
 * When omitted, `cardImageUrl` is null — this module does not re-resolve images.
 */
export function snapshotFromContentItem(
	item: {
		id: string;
		slug: string | null;
		status: string;
		data: Record<string, unknown>;
		seo?: { title?: string | null; description?: string | null; image?: unknown } | null;
	},
	options?: { siteOrigin?: string; cardImageUrl?: string | null },
): SharePostSnapshot {
	const data = item.data ?? {};
	const title = str(data.social_title) ?? str(item.seo?.title) ?? str(data.title) ?? '';
	const description = str(item.seo?.description) ?? str(data.lede) ?? str(data.excerpt) ?? '';
	const cardImageUrl =
		options && 'cardImageUrl' in options ? (options.cardImageUrl ?? null) : null;
	return {
		id: item.id,
		slug: item.slug,
		status: item.status,
		title,
		description,
		groups: organisationNames(data),
		cardImageUrl,
	};
}

function organisationNames(data: Record<string, unknown>): string[] {
	const value = data.organisations ?? data.organizations;
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const item of value) {
		if (typeof item === 'string') {
			const name = item.trim();
			if (name) names.push(name);
		} else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
			const name = (item as { name: string }).name.trim();
			if (name) names.push(name);
		}
	}
	return names;
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
