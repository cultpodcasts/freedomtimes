/**
 * X (Twitter) client for the admin-only "Post to X" panel (#20).
 *
 * Auth is OAuth 2.0 user context: refresh the stored refresh token for a short-lived
 * access token, then POST https://api.x.com/2/tweets with Authorization: Bearer.
 * Scopes required when minting the refresh token: tweet.read tweet.write users.read
 * offline.access. `fetch` is injected so tests mock it. It posts only from the
 * production admin (real account) or the staging admin with the staging-only
 * test-account secrets (#178); elsewhere it is a dry run.
 *
 * X may rotate the refresh token on each use (`offline.access`). Worker secrets are
 * immutable from inside the Worker, so the live refresh token is kept in plugin KV
 * (bootstrap from the env secret; write back on rotation; re-bootstrap when the
 * Worker secret is reminted). See web/docs/SOCIAL_SHARING.md.
 */
import { composeSocialText, socialHashtagLine } from './hashtags';
import type { FetchLike, ShareKv, ShareProvider } from './panel';
import { readSecret, ShareNetworkError, type SharedPost, type SocialShareMode } from './policy';

export const X_NETWORK = 'x';
export const X_API_ORIGIN = 'https://api.x.com';
export const X_HOST = 'api.x.com';
export const X_CREATE_POST_URL = `${X_API_ORIGIN}/2/tweets`;
export const X_OAUTH2_TOKEN_URL = `${X_API_ORIGIN}/2/oauth2/token`;
export const X_INTENT_POST_URL = 'https://x.com/intent/post';

/** Ready-to-send compose link. Opening it does not post; the person presses Post on X. */
export function xIntentUrl(text: string): string {
	const url = new URL(X_INTENT_POST_URL);
	url.searchParams.set('text', text);
	return url.toString();
}

/** Worker secret names (set via .env.dev → set-github-secrets.ps1; never committed). */
export const X_SECRET_NAMES = ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REFRESH_TOKEN'] as const;
/** Staging-only test-account secret names (#178). */
export const X_TEST_SECRET_NAMES = ['X_TEST_CLIENT_ID', 'X_TEST_CLIENT_SECRET', 'X_TEST_REFRESH_TOKEN'] as const;
/** Scopes to request when minting the production refresh token. */
export const X_OAUTH2_SCOPES = 'tweet.read tweet.write users.read offline.access' as const;
/** X's weighted post limit. */
export const X_MAX_WEIGHTED_LENGTH = 280;
/** Every URL is wrapped in t.co and counts as 23. */
export const X_URL_WEIGHT = 23;

/** Plugin KV key for the live OAuth 2.0 refresh token (production vs staging test). */
export function xRefreshTokenKvKey(mode: SocialShareMode = 'production'): string {
	return mode === 'staging' ? 'x-oauth-test:refresh-token' : 'x-oauth:refresh-token';
}

export interface XConfig {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	/** Confirm-dialog account phrase (production vs staging test). */
	accountLabel: string;
}

/** Config from `[clientId, clientSecret, refreshToken]`. Mode picks the account label. */
export function xConfigFromSecrets(
	[clientId, clientSecret, refreshToken]: readonly string[],
	mode: SocialShareMode = 'production',
): XConfig {
	return {
		clientId,
		clientSecret,
		refreshToken,
		accountLabel:
			mode === 'staging' ? 'the X staging test account' : 'the authorized Freedom Times X account',
	};
}

/** All three secrets present (by default the production names), or null. */
export function readXConfig(
	env: Record<string, unknown>,
	names: readonly string[] = X_SECRET_NAMES,
	mode: SocialShareMode = 'production',
): XConfig | null {
	const values = names.map((name) => readSecret(env, name));
	if (values.length !== 3 || values.some((v) => !v)) return null;
	return xConfigFromSecrets(values as string[], mode);
}

/** Account named in the confirm dialog (no paid users/me call). */
export function xAccountLabel(config: XConfig): string {
	return config.accountLabel;
}

/**
 * Read/write the live refresh token. Worker secrets cannot be updated from the
 * Worker; this store is how a rotated token survives until the next post.
 */
export interface XRefreshTokenStore {
	get(): Promise<string>;
	set(token: string): Promise<void>;
}

interface StoredXRefreshToken {
	token: string;
	/** Fingerprint of the Worker secret that bootstrapped this entry. */
	fromSecret: string;
}

async function secretFingerprint(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
	return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isStoredRefresh(value: unknown): value is StoredXRefreshToken {
	if (typeof value !== 'object' || value === null) return false;
	const rec = value as { token?: unknown; fromSecret?: unknown };
	return typeof rec.token === 'string' && rec.token.trim().length > 0 && typeof rec.fromSecret === 'string';
}

/**
 * Plugin-KV store for the live refresh token.
 * - Bootstrap from the Worker secret when KV is empty or the secret was reminted
 *   (fingerprint mismatch).
 * - On rotation, write the new token back with the current secret fingerprint.
 */
export function createXRefreshTokenStore(
	kv: ShareKv,
	envBootstrap: string,
	mode: SocialShareMode = 'production',
): XRefreshTokenStore {
	const key = xRefreshTokenKvKey(mode);
	let fingerprintPromise: Promise<string> | undefined;
	const fingerprint = () => {
		fingerprintPromise ??= secretFingerprint(envBootstrap);
		return fingerprintPromise;
	};
	return {
		async get() {
			const fp = await fingerprint();
			const hit = await kv.getVersioned<unknown>(key);
			if (hit && isStoredRefresh(hit.value) && hit.value.fromSecret === fp) {
				return hit.value.token.trim();
			}
			return envBootstrap;
		},
		async set(token: string) {
			const trimmed = token.trim();
			if (!trimmed) return;
			await kv.set(key, { token: trimmed, fromSecret: await fingerprint() } satisfies StoredXRefreshToken);
		},
	};
}

// twitter-text v3 weights: these code point ranges count 1, everything else 2;
// an emoji sequence counts 2 however many code points it has.
const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x0000, 0x10ff],
	[0x2000, 0x200d],
	[0x2010, 0x201f],
	[0x2032, 0x2037],
];
const EMOJI = /\p{Extended_Pictographic}/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function graphemeWeight(grapheme: string): number {
	if (EMOJI.test(grapheme)) return 2;
	let weight = 0;
	for (const ch of grapheme) {
		const cp = ch.codePointAt(0) ?? 0;
		weight += LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
	}
	return weight;
}

/** X's weighted length of plain text, with no URL detection. */
export function xTextWeight(text: string): number {
	let total = 0;
	for (const { segment } of segmenter.segment(text)) total += graphemeWeight(segment);
	return total;
}

/**
 * Anything X may auto-link: an http(s) URL, or a bare domain such as
 * `freedomtimes.news` or `bit.ly/x`. Deliberately broader than X's own
 * detection, so a title is never under-counted (at worst it is trimmed a bit more).
 */
const URL_LIKE = /(?:https?:\/\/)?(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?:\/[^\s]*)?/giu;

/** X's weighted length of post text: every URL-like token counts as 23 (t.co). */
export function xWeightedLength(text: string): number {
	let total = 0;
	let last = 0;
	for (const m of text.matchAll(URL_LIKE)) {
		total += xTextWeight(text.slice(last, m.index)) + X_URL_WEIGHT;
		last = (m.index ?? 0) + m[0].length;
	}
	return total + xTextWeight(text.slice(last));
}

const ELLIPSIS = '…';

/** Trim to at most `max` weighted characters (URL-like tokens count 23), ending with "…" when cut. */
export function truncateXWeighted(text: string, max: number): string {
	if (xWeightedLength(text) <= max) return text;
	let out = '';
	for (const { segment } of segmenter.segment(text)) {
		if (xWeightedLength(`${out}${segment}`.trimEnd() + ELLIPSIS) > max) break;
		out += segment;
	}
	const trimmed = out.trimEnd();
	return trimmed ? `${trimmed}${ELLIPSIS}` : '';
}

export interface XPostDraft {
	/** Exact post text: title, blank line, hashtags, blank line, article URL. */
	text: string;
	url: string;
	/** X's weighted length of `text` (URLs counted as 23). */
	weightedLength: number;
}

const SEPARATOR = '\n\n';

/** Title, blank line, hashtags, blank line, URL. Tags fill 280 (URL counted as 23). The title is trimmed only when the tags and the link leave no room. */
export function buildXDraft(input: {
	title: string;
	description: string;
	url: string;
	groups?: readonly string[];
	cardImageUrl?: string | null;
}): XPostDraft {
	const title0 = input.title.trim();
	const hashtags = socialHashtagLine(title0, input.url, input.groups ?? [], xWeightedLength, X_MAX_WEIGHTED_LENGTH);
	const tail = `${SEPARATOR}${hashtags}${SEPARATOR}${input.url}`;
	const room = X_MAX_WEIGHTED_LENGTH - xWeightedLength(tail);
	const title = truncateXWeighted(title0, Math.max(0, room));
	const text = composeSocialText(title, hashtags, input.url);
	return { text, url: input.url, weightedLength: xWeightedLength(text) };
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
	const raw = `${clientId}:${clientSecret}`;
	const bytes = new TextEncoder().encode(raw);
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return `Basic ${btoa(binary)}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await res.json();
		return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function xError(body: Record<string, unknown>, status: number): string {
	const first = Array.isArray(body.errors) ? (body.errors[0] as Record<string, unknown> | undefined) : undefined;
	const message = [body.detail, body.title, body.error_description, body.error, first?.message, body.message].find(
		(m) => typeof m === 'string',
	);
	return message ? `HTTP ${status}: ${String(message)}` : `HTTP ${status}`;
}

/**
 * Exchange the refresh token for a short-lived user access token.
 * When a store is provided, the live refresh token is read from it (KV, bootstrapped
 * from the Worker secret) and any rotated `refresh_token` is written back immediately.
 */
export async function refreshXAccessToken(
	config: XConfig,
	deps: { fetch: FetchLike; refreshTokenStore?: XRefreshTokenStore },
): Promise<{ accessToken: string; refreshToken?: string }> {
	const refreshToken = deps.refreshTokenStore ? await deps.refreshTokenStore.get() : config.refreshToken;
	let res: Response;
	try {
		res = await deps.fetch(X_OAUTH2_TOKEN_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				authorization: basicAuthHeader(config.clientId, config.clientSecret),
			},
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
			}).toString(),
		});
	} catch {
		throw new ShareNetworkError('Lost the connection while refreshing the X access token.', false);
	}
	const body = await readJson(res);
	if (!res.ok) {
		const definitelyNotPosted = res.status >= 400 && res.status < 500;
		throw new ShareNetworkError(`X refused to refresh the access token (${xError(body, res.status)}).`, definitelyNotPosted);
	}
	const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
	if (!accessToken) {
		throw new ShareNetworkError('X token refresh returned no access_token.', true);
	}
	const rotated = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined;
	if (rotated && deps.refreshTokenStore) {
		await deps.refreshTokenStore.set(rotated);
	}
	return { accessToken, refreshToken: rotated };
}

export interface XPublishDeps {
	fetch: FetchLike;
	now: () => Date;
	/** Plugin KV — required for live refresh-token persistence on panel / auto-post. */
	kv?: ShareKv;
	mode?: SocialShareMode;
}

/** Create the post. Never logs secrets. */
export async function postToX(config: XConfig, draft: XPostDraft, deps: XPublishDeps): Promise<SharedPost> {
	const refreshTokenStore =
		deps.kv !== undefined ? createXRefreshTokenStore(deps.kv, config.refreshToken, deps.mode ?? 'production') : undefined;
	const { accessToken } = await refreshXAccessToken(config, { fetch: deps.fetch, refreshTokenStore });
	let res: Response;
	try {
		res = await deps.fetch(X_CREATE_POST_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
			body: JSON.stringify({ text: draft.text }),
		});
	} catch {
		// The request may have reached X: keep the lock so nobody double posts.
		throw new ShareNetworkError('Lost the connection while posting to X; it may or may not have posted.', false);
	}
	const body = await readJson(res);
	if (!res.ok) {
		// 4xx (bad token, out of credits, rate limit, duplicate) means no post was made.
		const definitelyNotPosted = res.status >= 400 && res.status < 500;
		throw new ShareNetworkError(`X refused the post (${xError(body, res.status)}).`, definitelyNotPosted);
	}
	const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : {};
	const id = typeof data.id === 'string' && /^\d+$/.test(data.id) ? data.id : '';
	if (!id) {
		throw new ShareNetworkError('X accepted the request but returned no post id; check the X profile.', false);
	}
	return { id, url: `https://x.com/i/web/status/${id}` };
}

/** The "Post to X" panel provider. */
export const xProvider: ShareProvider<XConfig, XPostDraft> = {
	network: X_NETWORK,
	label: 'X',
	secretNames: X_SECRET_NAMES,
	testSecretNames: X_TEST_SECRET_NAMES,
	configFromSecrets: xConfigFromSecrets,
	accountLabel: xAccountLabel,
	buildDraft: buildXDraft,
	previewFields: (draft) => [{ label: 'Length (X counting, link = 23)', value: `${draft.weightedLength} / ${X_MAX_WEIGHTED_LENGTH}` }],
	publish: postToX,
	dryRunRequest: (draft) => ({ method: 'POST', url: X_CREATE_POST_URL, body: { text: draft.text } }),
	intentUrl: (draft) => xIntentUrl(draft.text),
};
