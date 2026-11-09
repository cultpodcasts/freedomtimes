/**
 * Bluesky (AT Protocol) client for the admin-only "Post to Bluesky" panel.
 *
 * Flow: com.atproto.server.createSession (handle + app password) →
 * optional read of the article OG image bytes (R2 / local media by storage
 * key — never a Worker→self HTTP fetch of `/_emdash/api/media/file/…`) +
 * com.atproto.repo.uploadBlob → com.atproto.repo.createRecord
 * (app.bsky.feed.post with a link facet and an app.bsky.embed.external link
 * card, thumb when upload succeeded). `fetch` is injected so tests mock it.
 * It posts only from the production admin (real account) or the staging
 * admin with the staging-only test-account secrets (#178); elsewhere it is a
 * dry run.
 *
 * Why R2 / storage, not HTTP: RedditPodcastPoster’s EmbedCardBuilder GETs an
 * *external* ThumbUrl (YouTube/Spotify CDN). FT’s card image is same-origin
 * EmDash media; `ctx.http.fetch` of that URL from inside the Worker hangs
 * until AbortSignal.timeout (see #192), so uploadBlueskyCardThumb returned
 * null and posts went out without embed.external.thumb. Read MEDIA by
 * storage key instead (same idea as archive-pdf’s env.MEDIA head).
 */
import { composeSocialText, socialHashtagLine } from './hashtags';
import type { FetchLike, ShareProvider } from './panel';
import {
	graphemeLength,
	isAllowedShareCardImageHost,
	readSecret,
	ShareNetworkError,
	type SharedPost,
	truncateGraphemes,
} from './policy';

export const BLUESKY_NETWORK = 'bluesky';
export const BLUESKY_SERVICE_ORIGIN = 'https://bsky.social';
export const BLUESKY_HOST = 'bsky.social';
export const BLUESKY_INTENT_COMPOSE_URL = 'https://bsky.app/intent/compose';
/** Same 1 MiB cap as RedditPodcastPoster BlueskyCardImageDownloader.MaxBytes. */
export const BLUESKY_CARD_IMAGE_MAX_BYTES = 1_000_000;
/**
 * Cap same-origin / network waits for the card image. A hung Worker→self fetch of
 * `/_emdash/api/media/file/…` otherwise holds the share claim in `pending` until the
 * client cancels, and the next click only shows a generic "Not posted" toast.
 */
export const BLUESKY_CARD_IMAGE_FETCH_TIMEOUT_MS = 8_000;

/** EmDash public media file path prefix (storage key is the path segment). */
export const BLUESKY_CARD_IMAGE_MEDIA_FILE_PREFIX = '/_emdash/api/media/file/';

/** Bytes + MIME for a card image already read from local storage (R2). */
export type BlueskyCardImageBytes = { bytes: Uint8Array; mimeType: string };

/**
 * Read card-image bytes by EmDash media storage key (no HTTP). Wired from the
 * plugin to `env.MEDIA.get`; tests inject a fake.
 */
export type ReadBlueskyCardImageBytes = (
	storageKey: string,
) => Promise<BlueskyCardImageBytes | null>;

/**
 * Storage key for an allowlisted Freedom Times EmDash media file URL, or null.
 * Matches archive-pdf’s path rules (percent-decode once; reject `..`).
 */
export function blueskyCardImageStorageKey(cardImageUrl: string | null | undefined): string | null {
	if (typeof cardImageUrl !== 'string' || !cardImageUrl.trim()) return null;
	let pathname: string;
	try {
		const parsed = new URL(cardImageUrl.trim());
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		if (!isAllowedShareCardImageHost(parsed.hostname)) return null;
		pathname = parsed.pathname;
	} catch {
		return null;
	}
	if (!pathname.startsWith(BLUESKY_CARD_IMAGE_MEDIA_FILE_PREFIX)) return null;
	const raw = pathname.slice(BLUESKY_CARD_IMAGE_MEDIA_FILE_PREFIX.length).split(/[?#]/, 1)[0] ?? '';
	if (!raw) return null;
	let key: string;
	try {
		key = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (!key || key.startsWith('/') || key.split('/').some((segment) => segment === '..' || segment === '.')) {
		return null;
	}
	return key;
}

/** MIME from a storage key / filename extension when R2 omits httpMetadata.contentType. */
export function blueskyCardImageMimeFromStorageKey(storageKey: string): string | null {
	const base = storageKey.split('/').pop() ?? storageKey;
	const dot = base.lastIndexOf('.');
	if (dot < 0) return null;
	switch (base.slice(dot + 1).toLowerCase()) {
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'webp':
			return 'image/webp';
		case 'gif':
			return 'image/gif';
		default:
			return null;
	}
}

/** Ready-to-send compose link. Opening it does not post; the person presses Post on Bluesky. */
export function blueskyIntentUrl(text: string): string {
	const url = new URL(BLUESKY_INTENT_COMPOSE_URL);
	url.searchParams.set('text', text);
	return url.toString();
}

/** Worker secret names (set by Jon on the production Worker; never committed). */
export const BLUESKY_SECRET_NAMES = ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'] as const;
/** Staging-only test-account secret names, same order (#178; set by Jon on the staging Worker only). */
export const BLUESKY_TEST_SECRET_NAMES = ['BLUESKY_TEST_HANDLE', 'BLUESKY_TEST_APP_PASSWORD'] as const;
/** app.bsky.feed.post text limit. */
export const BLUESKY_MAX_GRAPHEMES = 300;
const CARD_DESCRIPTION_MAX = 300;

export interface BlueskyConfig {
	handle: string;
	appPassword: string;
}

/** Config from `[handle, appPassword]` (a leading `@` on the handle is dropped). Mode is unused (label comes from the handle). */
export function blueskyConfigFromSecrets(
	[handle, appPassword]: readonly string[],
	_mode?: unknown,
): BlueskyConfig {
	return { handle: handle.replace(/^@/, ''), appPassword };
}

/** Both secrets present (by default the production names), or null (the panel then says it isn't configured). */
export function readBlueskyConfig(
	env: Record<string, unknown>,
	names: readonly string[] = BLUESKY_SECRET_NAMES,
): BlueskyConfig | null {
	const handle = readSecret(env, names[0]);
	const appPassword = readSecret(env, names[1]);
	if (!handle || !appPassword) return null;
	return blueskyConfigFromSecrets([handle, appPassword]);
}

export interface BlueskyPostDraft {
	/** Exact post text: title, blank line, hashtags, blank line, article URL. */
	text: string;
	url: string;
	cardTitle: string;
	cardDescription: string;
	/** Absolute OG/social image URL to upload as the link-card thumb, or null. */
	cardImageUrl: string | null;
}

export type ShareDraftInput = {
	title: string;
	description: string;
	url: string;
	groups?: readonly string[];
	cardImageUrl?: string | null;
};

/** Title, blank line, hashtags, blank line, URL. Tags fill 300 graphemes. The title is trimmed only when the tags and the link leave no room. */
export function buildBlueskyDraft(input: ShareDraftInput): BlueskyPostDraft {
	const title0 = input.title.trim();
	const hashtags = socialHashtagLine(title0, input.url, input.groups ?? [], graphemeLength, BLUESKY_MAX_GRAPHEMES);
	const tail = `\n\n${hashtags}\n\n${input.url}`;
	const room = BLUESKY_MAX_GRAPHEMES - graphemeLength(tail);
	const title = truncateGraphemes(title0, Math.max(0, room));
	return {
		text: composeSocialText(title, hashtags, input.url),
		url: input.url,
		cardTitle: title0 || input.url,
		cardDescription: truncateGraphemes(input.description.trim(), CARD_DESCRIPTION_MAX),
		cardImageUrl: input.cardImageUrl?.trim() ? input.cardImageUrl.trim() : null,
	};
}

/** UTF-8 byte range of the first occurrence of `needle` (AT Protocol facets index bytes, not chars). */
export function utf8ByteRange(text: string, needle: string): { byteStart: number; byteEnd: number } | null {
	const at = text.indexOf(needle);
	if (at < 0) return null;
	const enc = new TextEncoder();
	const byteStart = enc.encode(text.slice(0, at)).length;
	return { byteStart, byteEnd: byteStart + enc.encode(needle).length };
}

/** The app.bsky.feed.post record for a draft. `thumb` is the uploadBlob result when present. */
export function buildBlueskyRecord(
	draft: BlueskyPostDraft,
	createdAt: Date,
	thumb?: unknown,
): Record<string, unknown> {
	const facets: Array<Record<string, unknown>> = [];
	const link = utf8ByteRange(draft.text, draft.url);
	if (link) facets.push({ index: link, features: [{ $type: 'app.bsky.richtext.facet#link', uri: draft.url }] });
	for (const match of draft.text.matchAll(/(^|\s)(#[A-Za-z0-9]+)/g)) {
		const tag = match[2];
		const range = utf8ByteRange(draft.text, tag);
		if (!range || !tag) continue;
		facets.push({ index: range, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: tag.slice(1) }] });
	}
	const external: Record<string, unknown> = {
		uri: draft.url,
		title: draft.cardTitle,
		description: draft.cardDescription,
	};
	if (thumb != null) external.thumb = thumb;
	return {
		$type: 'app.bsky.feed.post',
		text: draft.text,
		createdAt: createdAt.toISOString(),
		langs: ['en'],
		...(facets.length > 0 ? { facets } : {}),
		embed: {
			$type: 'app.bsky.embed.external',
			external,
		},
	};
}

/** `at://did/app.bsky.feed.post/rkey` → `https://bsky.app/profile/did/post/rkey`. */
export function blueskyWebUrl(atUri: string): string | null {
	const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(atUri);
	return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await res.json();
		return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function xrpcError(body: Record<string, unknown>, status: number): string {
	const code = typeof body.error === 'string' ? body.error : `HTTP ${status}`;
	const message = typeof body.message === 'string' ? `: ${body.message}` : '';
	return `${code}${message}`;
}

/**
 * Read at most `maxBytes` from a Response. Rejects early on Content-Length when
 * present and over the cap; otherwise streams and aborts as soon as the
 * cumulative size exceeds the cap (never buffers an unbounded body first).
 */
export async function readResponseBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const contentLength = response.headers.get('content-length');
	if (contentLength != null) {
		const n = Number(contentLength);
		if (Number.isFinite(n) && n > maxBytes) return null;
	}

	const stream = response.body;
	if (!stream) {
		try {
			const buf = new Uint8Array(await response.arrayBuffer());
			if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null;
			return buf;
		} catch {
			return null;
		}
	}

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					/* ignore */
				}
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	if (total === 0) return null;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/**
 * Resolve card-image bytes for uploadBlob.
 *
 * Prefer `readCardImageBytes(storageKey)` when the URL is an allowlisted
 * EmDash media file (R2). Do **not** fall back to HTTP for those URLs: a
 * Worker `ctx.http.fetch` of its own `/_emdash/api/media/file/…` hangs until
 * the abort timeout. HTTP+timeout remains only for non-media allowlisted
 * URLs (tests / unexpected hosts) when no local reader is wired.
 */
export async function resolveBlueskyCardImageBytes(
	cardImageUrl: string | null,
	fetchLike: FetchLike,
	readCardImageBytes?: ReadBlueskyCardImageBytes,
): Promise<BlueskyCardImageBytes | null> {
	if (!cardImageUrl) return null;
	const storageKey = blueskyCardImageStorageKey(cardImageUrl);
	if (storageKey && readCardImageBytes) {
		try {
			const local = await readCardImageBytes(storageKey);
			if (!local) return null;
			if (!local.mimeType.toLowerCase().startsWith('image/')) return null;
			if (local.bytes.byteLength === 0 || local.bytes.byteLength > BLUESKY_CARD_IMAGE_MAX_BYTES) {
				return null;
			}
			return local;
		} catch {
			return null;
		}
	}

	let image: Response;
	try {
		image = await fetchLike(cardImageUrl, {
			signal: AbortSignal.timeout(BLUESKY_CARD_IMAGE_FETCH_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!image.ok) return null;
	const mime = (image.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
	if (!mime.toLowerCase().startsWith('image/')) return null;
	const bytes = await readResponseBodyCapped(image, BLUESKY_CARD_IMAGE_MAX_BYTES);
	if (!bytes) return null;
	return { bytes, mimeType: mime };
}

/**
 * Read the card image (R2 / local media, else HTTP) and upload it to Bluesky.
 * Returns the blob ref, or null when there is no URL / read / upload fails
 * (post still goes out with a text-only link card).
 */
export async function uploadBlueskyCardThumb(
	accessJwt: string,
	cardImageUrl: string | null,
	fetchLike: FetchLike,
	readCardImageBytes?: ReadBlueskyCardImageBytes,
): Promise<unknown | null> {
	const resolved = await resolveBlueskyCardImageBytes(cardImageUrl, fetchLike, readCardImageBytes);
	if (!resolved) return null;
	const { bytes, mimeType: mime } = resolved;

	let uploaded: Response;
	try {
		// TS 5.7+ Dom/Node typings: Uint8Array is generic over ArrayBufferLike; BodyInit/BlobPart
		// still expect ArrayBuffer-backed views. Runtime fetch accepts the bytes as-is.
		uploaded = await fetchLike(`${BLUESKY_SERVICE_ORIGIN}/xrpc/com.atproto.repo.uploadBlob`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${accessJwt}`,
				'content-type': mime,
			},
			body: bytes as unknown as BodyInit,
			signal: AbortSignal.timeout(BLUESKY_CARD_IMAGE_FETCH_TIMEOUT_MS),
		});
	} catch {
		return null;
	}
	if (!uploaded.ok) return null;
	const body = await readJson(uploaded);
	return body.blob ?? null;
}

/** Sign in with the app password and create the post. Never logs secrets. */
export async function postToBluesky(
	config: BlueskyConfig,
	draft: BlueskyPostDraft,
	deps: { fetch: FetchLike; now: () => Date; readCardImageBytes?: ReadBlueskyCardImageBytes },
): Promise<SharedPost> {
	let session: Response;
	try {
		session = await deps.fetch(`${BLUESKY_SERVICE_ORIGIN}/xrpc/com.atproto.server.createSession`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ identifier: config.handle, password: config.appPassword }),
		});
	} catch {
		throw new ShareNetworkError('Could not reach Bluesky to sign in.', true);
	}
	const sessionBody = await readJson(session);
	if (!session.ok) {
		throw new ShareNetworkError(`Bluesky sign-in failed (${xrpcError(sessionBody, session.status)}).`, true);
	}
	const accessJwt = sessionBody.accessJwt;
	const did = sessionBody.did;
	if (typeof accessJwt !== 'string' || typeof did !== 'string') {
		throw new ShareNetworkError('Bluesky sign-in returned no session.', true);
	}

	const thumb = await uploadBlueskyCardThumb(accessJwt, draft.cardImageUrl, deps.fetch, deps.readCardImageBytes);

	let created: Response;
	try {
		created = await deps.fetch(`${BLUESKY_SERVICE_ORIGIN}/xrpc/com.atproto.repo.createRecord`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${accessJwt}` },
			body: JSON.stringify({
				repo: did,
				collection: 'app.bsky.feed.post',
				record: buildBlueskyRecord(draft, deps.now(), thumb),
			}),
		});
	} catch {
		// The request may have reached Bluesky: keep the lock so nobody double posts.
		throw new ShareNetworkError('Lost the connection while posting to Bluesky; it may or may not have posted.', false);
	}
	const createdBody = await readJson(created);
	if (!created.ok) {
		const definitelyNotPosted = created.status >= 400 && created.status < 500;
		throw new ShareNetworkError(
			`Bluesky refused the post (${xrpcError(createdBody, created.status)}).`,
			definitelyNotPosted,
		);
	}
	const uri = typeof createdBody.uri === 'string' ? createdBody.uri : '';
	const url = blueskyWebUrl(uri);
	if (!url) {
		throw new ShareNetworkError('Bluesky accepted the post but returned no post URI; check the profile.', false);
	}
	return { id: uri, url };
}

/** The "Post to Bluesky" panel provider. */
export const blueskyProvider: ShareProvider<BlueskyConfig, BlueskyPostDraft> = {
	network: BLUESKY_NETWORK,
	label: 'Bluesky',
	secretNames: BLUESKY_SECRET_NAMES,
	testSecretNames: BLUESKY_TEST_SECRET_NAMES,
	configFromSecrets: blueskyConfigFromSecrets,
	accountLabel: (config) => `@${config.handle}`,
	buildDraft: buildBlueskyDraft,
	previewFields: (draft) => [
		{ label: 'Link card title', value: draft.cardTitle },
		...(draft.cardDescription ? [{ label: 'Link card description', value: draft.cardDescription }] : []),
		...(draft.cardImageUrl ? [{ label: 'Link card image', value: draft.cardImageUrl }] : []),
	],
	publish: postToBluesky,
	intentUrl: (draft) => blueskyIntentUrl(draft.text),
	// Thumb is omitted on dry-run: uploadBlob needs a live session. The intended
	// image URL (if any) is only in previewFields until a real/test post.
	dryRunRequest: (draft, now) => ({
		method: 'POST',
		url: `${BLUESKY_SERVICE_ORIGIN}/xrpc/com.atproto.repo.createRecord`,
		body: { repo: '<the account DID from createSession>', collection: 'app.bsky.feed.post', record: buildBlueskyRecord(draft, now) },
	}),
};
