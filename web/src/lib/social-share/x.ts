/**
 * X (Twitter) client for the admin-only "Post to X" panel (#20).
 *
 * One call: POST https://api.x.com/2/tweets {"text": …}, signed with OAuth
 * 1.0a user context (HMAC-SHA1 over the app's API key/secret and the
 * account's access token/secret). The JSON body is not part of the OAuth
 * signature. `fetch` is injected so tests mock it; nothing here ever runs
 * outside the production admin panel.
 */
import type { FetchLike, ShareProvider } from './panel';
import { readSecret, ShareNetworkError, type SharedPost } from './policy';

export const X_NETWORK = 'x';
export const X_API_ORIGIN = 'https://api.x.com';
export const X_HOST = 'api.x.com';
export const X_CREATE_POST_URL = `${X_API_ORIGIN}/2/tweets`;
/** Worker secret names (set by Jon on the production Worker; never committed). */
export const X_SECRET_NAMES = ['X_API_KEY', 'X_API_KEY_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'] as const;
/** X's weighted post limit. */
export const X_MAX_WEIGHTED_LENGTH = 280;
/** Every URL is wrapped in t.co and counts as 23. */
export const X_URL_WEIGHT = 23;

export interface XConfig {
	apiKey: string;
	apiKeySecret: string;
	accessToken: string;
	accessTokenSecret: string;
}

/** All four secrets present, or null (the panel then says it isn't configured). */
export function readXConfig(env: Record<string, unknown>): XConfig | null {
	const apiKey = readSecret(env, 'X_API_KEY');
	const apiKeySecret = readSecret(env, 'X_API_KEY_SECRET');
	const accessToken = readSecret(env, 'X_ACCESS_TOKEN');
	const accessTokenSecret = readSecret(env, 'X_ACCESS_TOKEN_SECRET');
	if (!apiKey || !apiKeySecret || !accessToken || !accessTokenSecret) return null;
	return { apiKey, apiKeySecret, accessToken, accessTokenSecret };
}

/**
 * Account named in the confirm dialog. X access tokens start with the
 * account's numeric user id (`<id>-…`); showing it avoids a paid users/me call.
 */
export function xAccountLabel(config: XConfig): string {
	const id = /^(\d+)-/.exec(config.accessToken)?.[1];
	return id ? `the X account with user id ${id}` : 'the X account that owns the access token';
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
	/** Exact post text: title, blank line, article URL. */
	text: string;
	url: string;
	/** X's weighted length of `text` (URLs counted as 23). */
	weightedLength: number;
}

const SEPARATOR = '\n\n';

/** Title + blank line + URL, with the title trimmed so the post fits 280 (URL counted as 23). */
export function buildXDraft(input: { title: string; description: string; url: string }): XPostDraft {
	const room = X_MAX_WEIGHTED_LENGTH - X_URL_WEIGHT - xTextWeight(SEPARATOR);
	const title = truncateXWeighted(input.title.trim(), room);
	const text = title ? `${title}${SEPARATOR}${input.url}` : input.url;
	return { text, url: input.url, weightedLength: xWeightedLength(text) };
}

/** RFC 3986 percent-encoding, as X's OAuth 1.0a guide requires. */
export function oauthPercentEncode(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function base64(bytes: ArrayBuffer): string {
	let binary = '';
	for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** OAuth 1.0a HMAC-SHA1 signature (docs.x.com "Creating a signature"). */
export async function oauth1Signature(input: {
	method: string;
	url: string;
	params: Record<string, string>;
	consumerSecret: string;
	tokenSecret: string;
}): Promise<string> {
	const paramString = Object.entries(input.params)
		.map(([k, v]) => [oauthPercentEncode(k), oauthPercentEncode(v)] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join('&');
	const baseString = [input.method.toUpperCase(), oauthPercentEncode(input.url), oauthPercentEncode(paramString)].join(
		'&',
	);
	const signingKey = `${oauthPercentEncode(input.consumerSecret)}&${oauthPercentEncode(input.tokenSecret)}`;
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', enc.encode(signingKey), { name: 'HMAC', hash: 'SHA-1' }, false, [
		'sign',
	]);
	return base64(await crypto.subtle.sign('HMAC', key, enc.encode(baseString)));
}

/** `Authorization: OAuth …` header for a JSON-body request (only oauth_* params are signed). */
export async function oauth1Header(input: {
	method: string;
	url: string;
	config: XConfig;
	nonce: string;
	timestamp: number;
}): Promise<string> {
	const oauth: Record<string, string> = {
		oauth_consumer_key: input.config.apiKey,
		oauth_nonce: input.nonce,
		oauth_signature_method: 'HMAC-SHA1',
		oauth_timestamp: String(input.timestamp),
		oauth_token: input.config.accessToken,
		oauth_version: '1.0',
	};
	oauth.oauth_signature = await oauth1Signature({
		method: input.method,
		url: input.url,
		params: oauth,
		consumerSecret: input.config.apiKeySecret,
		tokenSecret: input.config.accessTokenSecret,
	});
	return `OAuth ${Object.keys(oauth)
		.sort()
		.map((k) => `${oauthPercentEncode(k)}="${oauthPercentEncode(oauth[k])}"`)
		.join(', ')}`;
}

function randomNonce(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
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
	const message = [body.detail, body.title, first?.message, body.message].find((m) => typeof m === 'string');
	return message ? `HTTP ${status}: ${String(message)}` : `HTTP ${status}`;
}

/** Create the post. Never logs secrets. */
export async function postToX(
	config: XConfig,
	draft: XPostDraft,
	deps: { fetch: FetchLike; now: () => Date },
): Promise<SharedPost> {
	const authorization = await oauth1Header({
		method: 'POST',
		url: X_CREATE_POST_URL,
		config,
		nonce: randomNonce(),
		timestamp: Math.floor(deps.now().getTime() / 1000),
	});
	let res: Response;
	try {
		res = await deps.fetch(X_CREATE_POST_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization },
			body: JSON.stringify({ text: draft.text }),
		});
	} catch {
		// The request may have reached X: keep the lock so nobody double posts.
		throw new ShareNetworkError('Lost the connection while posting to X; it may or may not have posted.', false);
	}
	const body = await readJson(res);
	if (!res.ok) {
		// 4xx (bad keys, read-only app, out of credits, rate limit, duplicate) means no post was made.
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
	readConfig: readXConfig,
	accountLabel: xAccountLabel,
	buildDraft: buildXDraft,
	previewFields: (draft) => [{ label: 'Length (X counting, link = 23)', value: `${draft.weightedLength} / ${X_MAX_WEIGHTED_LENGTH}` }],
	publish: postToX,
};
