/**
 * Social / OG image resolution for article pages and the recent-posts feed.
 *
 * Why this lives apart from `contentEntry.ts` (#125): `resolveSocialImageSrc` runs from
 * `EmDashContentView.astro`'s **component** frontmatter, which runs after Astro has sent the 200
 * headers. A throw there cuts the article off mid-stream (the #123 failure mode), so this module
 * must never reject: creating the libsql client and every Turso / media-API lookup is caught,
 * logged, and the resolver falls back (no OG image from that source, then `social_image`, then
 * the featured / cover hero image).
 *
 * This is not the #128 content-store guard. A content store that is down or unmigrated is caught
 * earlier, by the entry lookup in the **page** frontmatter, which still answers 503 + `Retry-After`
 * (`src/lib/content-store-guard.ts`). By the time this resolver runs the status line is already
 * sent, so a 503 is no longer possible; degrading is the only safe outcome.
 *
 * Pure and runtime-free: the libsql client comes in through a factory (`contentEntry.ts` passes
 * the real `@libsql/client/web` one), so `scripts/test-social-image.mts` can load this module and
 * make the factory or its queries throw.
 */
import { normalizeToPublicMediaFilePath } from './mediaFileUrl';
import { asMediaRecord, readMediaValueSrc as readFeaturedImageSrc, readNonBlankString } from './mediaValue';

const LOG_PREFIX = '[contentEntry] resolveSocialImageSrc';

/** The slice of a libsql client this module uses (`@libsql/client/web` `Client` satisfies it). */
export type SocialImageQueryClient = {
	execute(statement: { sql: string; args: string[] }): Promise<{ rows: unknown[] }>;
};

/** Builds the client, or returns `null` when Turso is not configured. May throw (bad URL / scheme). */
export type SocialImageClientFactory = () => SocialImageQueryClient | null;

export type ResolveSocialImageSrcOptions = {
	/** Same-origin base URL (e.g. `Astro.url.origin`) for resolving bare media ids without Turso. */
	origin?: string;
	/**
	 * EmDash stores admin SEO (`seo.image`) in **`_emdash_seo`**, not always in `entry.data.seo` JSON.
	 * Pass **`collection`** (`posts`, `pages`, …) and **`contentId`** (`entry.id`) so Turso can read **`seo_image`**.
	 */
	emdashSeoLookup?: { collection: string; contentId: string; slug?: string };
};

const MEDIA_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{20,36}$/i;

/**
 * When an image field is only a media row id (no `meta.storageKey`), resolve R2 `storage_key` from Turso.
 * Skips if the field already yields a public `/file/` path from {@link readFeaturedImageSrc}.
 */
export function extractImageFieldMediaIdForLookup(raw: unknown): string | null {
	if (typeof raw === 'string') {
		const t = raw.trim();
		if (!t) return null;
		const parsed = asMediaRecord(t);
		if (parsed) return extractImageFieldMediaIdForLookup(parsed);
		if (normalizeToPublicMediaFilePath(t)) return null;
		if (MEDIA_ID_PATTERN.test(t)) return t;
		return null;
	}
	if (raw && typeof raw === 'object') {
		const o = raw as Record<string, unknown>;
		const meta = o.meta && typeof o.meta === 'object' ? (o.meta as Record<string, unknown>) : null;
		if (
			readNonBlankString(meta?.storageKey)
			?? readNonBlankString(meta?.storage_key)
			?? readNonBlankString(o.storageKey)
			?? readNonBlankString(o.storage_key)
		) {
			return null;
		}
		const id = readNonBlankString(o.id);
		if (id && MEDIA_ID_PATTERN.test(id)) return id;
		const src = readNonBlankString(o.src) ?? readNonBlankString(o.url);
		if (src && !normalizeToPublicMediaFilePath(src) && MEDIA_ID_PATTERN.test(src)) {
			return src;
		}
	}
	return null;
}

/**
 * One client per resolve call, created on first use. A factory that throws is logged once and
 * treated as "no Turso", so the remaining lookups in the same call skip straight to their fallbacks.
 */
function lazyClient(factory: SocialImageClientFactory): () => SocialImageQueryClient | null {
	let resolved: { client: SocialImageQueryClient | null } | undefined;
	return () => {
		if (resolved) return resolved.client;
		try {
			resolved = { client: factory() };
		} catch (err) {
			console.error(`${LOG_PREFIX}: libsql client creation failed; skipping Turso lookups`, err);
			resolved = { client: null };
		}
		return resolved.client;
	};
}

async function resolveStorageKeyFromMediaApi(origin: string, mediaId: string): Promise<string | null> {
	const base = origin.replace(/\/$/, '');
	try {
		const r = await fetch(`${base}/_emdash/api/media/${encodeURIComponent(mediaId)}`, {
			headers: { Accept: 'application/json' },
		});
		if (!r.ok) return null;
		const j = (await r.json()) as {
			data?: { item?: { storageKey?: string } };
			item?: { storageKey?: string };
		};
		const item = j.data?.item ?? j.item;
		const sk = item && typeof item.storageKey === 'string' ? item.storageKey.trim() : '';
		return sk.length > 0 ? sk : null;
	} catch {
		return null;
	}
}

const EMDASH_COLLECTION_TABLE: Record<string, string> = {
	posts: 'ec_posts',
	pages: 'ec_pages',
	archives: 'ec_archives',
};

function pickSeoImageRow(rows: unknown): string | null {
	const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
	const img = row && typeof row.seo_image === 'string' ? row.seo_image.trim() : '';
	return img.length > 0 ? img : null;
}

async function fetchEmdashSeoImageFromTable(
	getClient: () => SocialImageQueryClient | null,
	collection: string,
	contentId: string,
	slug?: string | null,
): Promise<string | null> {
	try {
		const client = getClient();
		if (!client) return null;
		if (contentId) {
			const res = await client.execute({
				sql: 'select seo_image from _emdash_seo where collection = ? and content_id = ? limit 1',
				args: [collection, contentId],
			});
			const found = pickSeoImageRow(res.rows);
			if (found) return found;
		}

		const table = EMDASH_COLLECTION_TABLE[collection];
		if (table && slug) {
			const res = await client.execute({
				sql: `select s.seo_image from _emdash_seo s inner join ${table} c on c.id = s.content_id where s.collection = ? and c.slug = ? limit 1`,
				args: [collection, slug],
			});
			return pickSeoImageRow(res.rows);
		}
	} catch (err) {
		console.error(`${LOG_PREFIX}: _emdash_seo lookup failed`, err);
	}
	return null;
}

async function resolveMediaIdToPublicPath(
	getClient: () => SocialImageQueryClient | null,
	mediaId: string,
	options?: ResolveSocialImageSrcOptions,
): Promise<string | null> {
	try {
		const client = getClient();
		if (client) {
			const res = await client.execute({
				sql: 'select storage_key from media where id = ? limit 1',
				args: [mediaId],
			});
			const row = res.rows[0] as Record<string, unknown> | undefined;
			const key = row && typeof row.storage_key === 'string' ? row.storage_key.trim() : '';
			if (key.length > 0) {
				return `/_emdash/api/media/file/${key}`;
			}
		}
	} catch (err) {
		console.error(`${LOG_PREFIX}: Turso media lookup failed`, err);
	}

	const origin = options?.origin?.trim();
	if (origin) {
		const sk = await resolveStorageKeyFromMediaApi(origin, mediaId);
		if (sk) return `/_emdash/api/media/file/${sk}`;
	}
	return null;
}

function readHeroFallback(data: Record<string, unknown>): string | null {
	return readFeaturedImageSrc(data.featured_image) ?? readFeaturedImageSrc(data.cover_image) ?? null;
}

/** Where the OG image came from. `hero` means there was no social image, so the featured/cover photo is used. */
export type SocialImageSource = 'social' | 'hero';

export type SocialImageResolution = {
	src: string | null;
	/** True only when `src` is the featured/cover hero because no social image resolved. */
	fellBackToHero: boolean;
};

function resolution(src: string | null, source: SocialImageSource | null): SocialImageResolution {
	return { src, fellBackToHero: source === 'hero' && src !== null };
}

async function resolveSocialImageSrcUnguarded(
	getClient: () => SocialImageQueryClient | null,
	data: Record<string, unknown>,
	seo: Record<string, unknown> | null | undefined,
	options: ResolveSocialImageSrcOptions | undefined,
	heroFallback: string | null,
): Promise<SocialImageResolution> {
	let fromSeo = seo ? readFeaturedImageSrc(seo.image) : null;
	if (!fromSeo && seo) {
		const seoMediaId = extractImageFieldMediaIdForLookup(seo.image);
		if (seoMediaId) fromSeo = await resolveMediaIdToPublicPath(getClient, seoMediaId, options);
	}
	if (!fromSeo && options?.emdashSeoLookup) {
		const lu = options.emdashSeoLookup;
		const raw = await fetchEmdashSeoImageFromTable(getClient, lu.collection, lu.contentId, lu.slug);
		if (raw) fromSeo = readFeaturedImageSrc(raw);
	}
	if (fromSeo) return resolution(fromSeo, 'social');

	const direct =
		readFeaturedImageSrc(data.social_image) ?? readFeaturedImageSrc(data.socialImage) ?? null;
	if (direct) return resolution(direct, 'social');

	const socialMediaId =
		extractImageFieldMediaIdForLookup(data.social_image)
		?? extractImageFieldMediaIdForLookup(data.socialImage);
	if (socialMediaId) {
		const fromSocial = await resolveMediaIdToPublicPath(getClient, socialMediaId, options);
		if (fromSocial) return resolution(fromSocial, 'social');
	}

	/**
	 * Bare `seo.image` ids may fail lookup if Turso is unset and media API is auth-only. Fall back to the
	 * hero so `og:image` / `twitter:image` are not empty when the post has a featured image.
	 */
	return resolution(heroFallback, heroFallback ? 'hero' : null);
}

/**
 * OG image: `seo.image` (path, or bare media id via Turso / media API), then `_emdash_seo.seo_image`,
 * then `social_image`, then the featured / cover hero. **Never rejects** (see the module comment):
 * any failure is logged and resolves to the hero fallback (or `null` when there is no hero).
 */
export async function resolveSocialImageWith(
	createClient: SocialImageClientFactory,
	data: Record<string, unknown>,
	seo?: Record<string, unknown> | null,
	options?: ResolveSocialImageSrcOptions,
): Promise<SocialImageResolution> {
	let heroFallback: string | null = null;
	try {
		heroFallback = readHeroFallback(data);
		return await resolveSocialImageSrcUnguarded(lazyClient(createClient), data, seo, options, heroFallback);
	} catch (err) {
		console.error(`${LOG_PREFIX}: unexpected failure; using the hero image`, err);
		return resolution(heroFallback, heroFallback ? 'hero' : null);
	}
}

/** `src` from {@link resolveSocialImageWith}. Existing callers only need the URL. */
export async function resolveSocialImageSrcWith(
	createClient: SocialImageClientFactory,
	data: Record<string, unknown>,
	seo?: Record<string, unknown> | null,
	options?: ResolveSocialImageSrcOptions,
): Promise<string | null> {
	return (await resolveSocialImageWith(createClient, data, seo, options)).src;
}
