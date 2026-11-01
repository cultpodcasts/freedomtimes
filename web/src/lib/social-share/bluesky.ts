/**
 * Bluesky (AT Protocol) client for the admin-only "Post to Bluesky" panel.
 *
 * Flow: com.atproto.server.createSession (handle + app password) →
 * com.atproto.repo.createRecord (app.bsky.feed.post with a link facet and an
 * app.bsky.embed.external link card). `fetch` is injected so tests mock it.
 * It posts only from the production admin (real account) or the staging admin
 * with the staging-only test-account secrets (#178); elsewhere it is a dry run.
 */
import { composeSocialText, socialHashtagLine } from './hashtags';
import type { FetchLike, ShareProvider } from './panel';
import { graphemeLength, readSecret, ShareNetworkError, type SharedPost, truncateGraphemes } from './policy';

export const BLUESKY_NETWORK = 'bluesky';
export const BLUESKY_SERVICE_ORIGIN = 'https://bsky.social';
export const BLUESKY_HOST = 'bsky.social';
export const BLUESKY_INTENT_COMPOSE_URL = 'https://bsky.app/intent/compose';

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

/** Config from `[handle, appPassword]` (a leading `@` on the handle is dropped). */
export function blueskyConfigFromSecrets([handle, appPassword]: readonly string[]): BlueskyConfig {
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
}

/** Title, blank line, hashtags, blank line, URL. Tags fill 300 graphemes. The title is trimmed only when the tags and the link leave no room. */
export function buildBlueskyDraft(input: { title: string; description: string; url: string; groups?: readonly string[] }): BlueskyPostDraft {
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

/** The app.bsky.feed.post record for a draft. */
export function buildBlueskyRecord(draft: BlueskyPostDraft, createdAt: Date): Record<string, unknown> {
	const facets: Array<Record<string, unknown>> = [];
	const link = utf8ByteRange(draft.text, draft.url);
	if (link) facets.push({ index: link, features: [{ $type: 'app.bsky.richtext.facet#link', uri: draft.url }] });
	for (const match of draft.text.matchAll(/(^|\s)(#[A-Za-z0-9]+)/g)) {
		const tag = match[2];
		const range = utf8ByteRange(draft.text, tag);
		if (!range || !tag) continue;
		facets.push({ index: range, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: tag.slice(1) }] });
	}
	return {
		$type: 'app.bsky.feed.post',
		text: draft.text,
		createdAt: createdAt.toISOString(),
		langs: ['en'],
		...(facets.length > 0 ? { facets } : {}),
		embed: {
			$type: 'app.bsky.embed.external',
			external: { uri: draft.url, title: draft.cardTitle, description: draft.cardDescription },
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

/** Sign in with the app password and create the post. Never logs secrets. */
export async function postToBluesky(
	config: BlueskyConfig,
	draft: BlueskyPostDraft,
	deps: { fetch: FetchLike; now: () => Date },
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

	let created: Response;
	try {
		created = await deps.fetch(`${BLUESKY_SERVICE_ORIGIN}/xrpc/com.atproto.repo.createRecord`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${accessJwt}` },
			body: JSON.stringify({
				repo: did,
				collection: 'app.bsky.feed.post',
				record: buildBlueskyRecord(draft, deps.now()),
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
	],
	publish: postToBluesky,
	intentUrl: (draft) => blueskyIntentUrl(draft.text),
	dryRunRequest: (draft, now) => ({
		method: 'POST',
		url: `${BLUESKY_SERVICE_ORIGIN}/xrpc/com.atproto.repo.createRecord`,
		body: { repo: '<the account DID from createSession>', collection: 'app.bsky.feed.post', record: buildBlueskyRecord(draft, now) },
	}),
};
