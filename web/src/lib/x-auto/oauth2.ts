/**
 * X API v2 user-context calls for Stage B (OAuth 2.0, PKCE, refresh token).
 *
 * The Worker never runs the browser consent step. Jon does that once
 * (web/scripts/x-oauth2-pkce.mts) and stores the refresh token as a secret.
 * Each post refreshes the access token, saves a rotated refresh token, then
 * calls POST /2/tweets. `fetch` is injected so tests never reach X.
 */
import type { FetchLike } from '../social-share/panel.ts';
import { X_CREATE_POST_URL } from '../social-share/x.ts';

export const X_OAUTH2_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const X_OAUTH2_SECRET_NAMES = ['X_OAUTH2_CLIENT_ID', 'X_OAUTH2_CLIENT_SECRET', 'X_OAUTH2_REFRESH_TOKEN'] as const;

export interface XOauth2Config {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}

export interface XTweet {
	id: string;
	url: string;
}

export class XOauth2Error extends Error {
	/** True when X rejected the call before a post could exist. */
	readonly definitelyNotPosted: boolean;
	constructor(message: string, definitelyNotPosted: boolean) {
		super(message);
		this.name = 'XOauth2Error';
		this.definitelyNotPosted = definitelyNotPosted;
	}
}

function readSecret(env: Record<string, unknown>, name: string): string | undefined {
	const value = env[name];
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** All three secrets present, or null. */
export function readXOauth2Config(env: Record<string, unknown>, refreshToken?: string): XOauth2Config | null {
	const clientId = readSecret(env, 'X_OAUTH2_CLIENT_ID');
	const clientSecret = readSecret(env, 'X_OAUTH2_CLIENT_SECRET');
	const token = refreshToken?.trim() || readSecret(env, 'X_OAUTH2_REFRESH_TOKEN');
	if (!clientId || !clientSecret || !token) return null;
	return { clientId, clientSecret, refreshToken: token };
}

function basicAuth(clientId: string, clientSecret: string): string {
	return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await res.json();
		return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function errorText(body: Record<string, unknown>, status: number): string {
	const description = [body.error_description, body.detail, body.title, body.error].find((m) => typeof m === 'string');
	return description ? `HTTP ${status}: ${String(description)}` : `HTTP ${status}`;
}

export interface RefreshedXToken {
	accessToken: string;
	/** The refresh token to store. X rotates it; the previous one is then dead. */
	refreshToken: string;
}

/** Exchange the refresh token. Does not log secrets. */
export async function refreshXUserToken(config: XOauth2Config, fetch: FetchLike): Promise<RefreshedXToken> {
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: config.refreshToken,
		client_id: config.clientId,
	});
	let res: Response;
	try {
		res = await fetch(X_OAUTH2_TOKEN_URL, {
			method: 'POST',
			headers: {
				authorization: basicAuth(config.clientId, config.clientSecret),
				'content-type': 'application/x-www-form-urlencoded',
			},
			body: body.toString(),
		});
	} catch {
		throw new XOauth2Error('Lost the connection while refreshing the X token. Nothing was posted.', true);
	}
	const json = await readJson(res);
	if (!res.ok) {
		throw new XOauth2Error(`X refused to refresh the token (${errorText(json, res.status)}). Nothing was posted.`, true);
	}
	const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
	const refreshToken = typeof json.refresh_token === 'string' && json.refresh_token.length > 0
		? json.refresh_token
		: config.refreshToken;
	if (!accessToken) {
		throw new XOauth2Error('X refreshed the token but returned no access token. Nothing was posted.', true);
	}
	return { accessToken, refreshToken };
}

/** POST /2/tweets with a user access token. */
export async function createXTweet(accessToken: string, text: string, fetch: FetchLike): Promise<XTweet> {
	let res: Response;
	try {
		res = await fetch(X_CREATE_POST_URL, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${accessToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ text }),
		});
	} catch {
		throw new XOauth2Error('Lost the connection while posting to X. It may or may not have posted.', false);
	}
	const json = await readJson(res);
	if (!res.ok) {
		const definitelyNotPosted = res.status >= 400 && res.status < 500;
		throw new XOauth2Error(`X refused the post (${errorText(json, res.status)}).`, definitelyNotPosted);
	}
	const data = typeof json.data === 'object' && json.data !== null ? (json.data as Record<string, unknown>) : {};
	const id = typeof data.id === 'string' && /^\d+$/.test(data.id) ? data.id : '';
	if (!id) {
		throw new XOauth2Error('X accepted the request but returned no post id. Check the X profile before trying again.', false);
	}
	return { id, url: `https://x.com/i/web/status/${id}` };
}
