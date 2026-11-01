/**
 * What happens when a post is published.
 *
 * Production with X_AUTO_POST_MODE=intent emails Jon a ready-to-send
 * https://x.com/intent/post link (Stage A). X_AUTO_POST_MODE=api posts through
 * the X API instead (Stage B). Staging, local, and any Worker without
 * X_AUTO_POST_ALLOW_SEND=yes dry-run: they build the same text and link and
 * send nothing. A sent post is recorded by id, so a later edit or republish
 * does not send again. A dry run records nothing.
 */
import type { FetchLike, ShareKv } from '../social-share/panel.ts';
import { snapshotFromContentItem } from '../social-share/policy.ts';
import { composeXPost, formatLondon, xAutoArticleUrl, type XAutoDraft } from './compose.ts';
import { effectiveXAutoMode, type XAutoConfiguredMode } from './mode.ts';
import { createXTweet, readXOauth2Config, refreshXUserToken, XOauth2Error, type XOauth2Config } from './oauth2.ts';

/** How long a crashed attempt blocks a retry. After this, a republish can try again. */
export const X_AUTO_STALE_PENDING_MS = 2 * 60 * 1000;
export const X_AUTO_NOTIFY_DEFAULT = 'socialmedia@freedomtimes.news';
const REFRESH_KEY = 'oauth2-refresh-token';

export interface XAutoEmail {
	to: string;
	subject: string;
	text: string;
}

export interface XAutoRecord {
	status: 'pending' | 'sent';
	mode: 'intent' | 'api';
	text: string;
	at: string;
	tweetId?: string;
	tweetUrl?: string;
}

export interface XAutoResult {
	action: 'skip' | 'dry-run' | 'intent' | 'api';
	reason?: string;
	draft?: XAutoDraft;
	tweetUrl?: string;
}

export interface XAutoDeps {
	env: Record<string, unknown>;
	kv: ShareKv;
	now: () => Date;
	sendEmail: (message: XAutoEmail) => Promise<void>;
	fetch: FetchLike;
	log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

interface RefreshStore {
	token: string;
}

function notifyTo(env: Record<string, unknown>): string {
	const raw = typeof env.X_AUTO_POST_NOTIFY_TO === 'string' ? env.X_AUTO_POST_NOTIFY_TO.trim() : '';
	return raw.length > 0 ? raw : X_AUTO_NOTIFY_DEFAULT;
}

function recordKey(postId: string): string {
	return `x-auto:${postId}`;
}

function isRecord(value: unknown): value is XAutoRecord {
	if (typeof value !== 'object' || value === null) return false;
	const status = (value as { status?: unknown }).status;
	return status === 'pending' || status === 'sent';
}

async function releaseClaim(kv: ShareKv, key: string): Promise<void> {
	const current = await kv.getVersioned<XAutoRecord>(key);
	if (!current) return;
	await kv.compareAndDelete(key, current.revision);
}

function emailForIntent(draft: XAutoDraft, when: Date): { subject: string; text: string } {
	const subject = `Post this on X: ${draft.text.split('\n')[0]}`.slice(0, 180);
	const text = [
		'Freedom Times published an article. Nothing has been posted to X yet.',
		'',
		draft.text,
		'',
		'Open this link and press Post:',
		draft.intentUrl,
		'',
		`Published: ${formatLondon(when)}`,
		`Article: ${draft.url}`,
		'',
		'The site drafted this for @_freedomtimes. You press Post.',
	].join('\n');
	return { subject, text };
}

function emailForApi(draft: XAutoDraft, tweetUrl: string, when: Date): { subject: string; text: string } {
	const subject = `Posted on X: ${draft.text.split('\n')[0]}`.slice(0, 180);
	const text = [
		'Freedom Times posted this to @_freedomtimes.',
		'',
		draft.text,
		'',
		tweetUrl,
		'',
		`Published: ${formatLondon(when)}`,
		`Article: ${draft.url}`,
	].join('\n');
	return { subject, text };
}

async function currentRefreshToken(kv: ShareKv, env: Record<string, unknown>): Promise<XOauth2Config | null> {
	const stored = await kv.getVersioned<RefreshStore>(REFRESH_KEY);
	const token = stored?.value && typeof stored.value.token === 'string' ? stored.value.token : undefined;
	return readXOauth2Config(env, token);
}

async function saveRefreshToken(kv: ShareKv, token: string, at: string): Promise<void> {
	let last: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			await kv.set(REFRESH_KEY, { token, at } satisfies RefreshStore & { at: string });
			return;
		} catch (error) {
			last = error;
		}
	}
	throw new XOauth2Error(
		`The X refresh token rotated but could not be saved (${last instanceof Error ? last.message : 'KV write failed'}). Run the PKCE script again and update the secret before the next post.`,
		true,
	);
}

/**
 * Handle one publish. Safe to call from the EmDash afterPublish hook.
 * Returns what it did. Never throws for a skip; a failed send releases the
 * claim and rethrows so the hook log shows the failure.
 */
export async function handleXAutoPublish(
	content: Record<string, unknown>,
	collection: string,
	deps: XAutoDeps,
): Promise<XAutoResult> {
	if (collection !== 'posts') return { action: 'skip', reason: 'not-a-post' };

	const mode = effectiveXAutoMode(deps.env);
	if (mode === 'off') return { action: 'skip', reason: 'off' };

	const data = content.data && typeof content.data === 'object' ? (content.data as Record<string, unknown>) : {};
	const seo = content.seo && typeof content.seo === 'object'
		? (content.seo as { title?: string | null; description?: string | null })
		: null;
	const id = typeof content.id === 'string' ? content.id : '';
	const slug = typeof content.slug === 'string' ? content.slug : null;
	const status = typeof content.status === 'string' ? content.status : '';
	if (!id || !slug || status !== 'published') {
		return { action: 'skip', reason: 'not-a-published-post' };
	}

	const snapshot = snapshotFromContentItem({ id, slug, status, data, seo });
	if (!snapshot.title) return { action: 'skip', reason: 'no-headline' };

	const draft = composeXPost({
		headline: snapshot.title,
		hook: snapshot.description,
		url: xAutoArticleUrl(slug),
	});

	if (mode === 'dry-run') {
		deps.log('info', `dry-run ${id} (${draft.weightedLength} weighted) ${draft.intentUrl}`);
		return { action: 'dry-run', draft };
	}

	const key = recordKey(id);
	const existing = await deps.kv.getVersioned<unknown>(key);
	const record = existing && isRecord(existing.value) ? existing.value : null;
	if (record?.status === 'sent') return { action: 'skip', reason: 'already-sent', draft };
	if (record?.status === 'pending') {
		const age = deps.now().getTime() - Date.parse(record.at);
		if (Number.isFinite(age) && age >= 0 && age < X_AUTO_STALE_PENDING_MS) {
			return { action: 'skip', reason: 'in-progress', draft };
		}
	}

	const pending: XAutoRecord = { status: 'pending', mode, text: draft.text, at: deps.now().toISOString() };
	const claim = await deps.kv.compareAndSet(key, existing?.revision ?? null, pending);
	if (!claim.applied) return { action: 'skip', reason: 'lost-race', draft };

	try {
		if (mode === 'intent') {
			await deliverIntent(draft, deps);
			await deps.kv.set(key, { ...pending, status: 'sent', at: deps.now().toISOString() } satisfies XAutoRecord);
			deps.log('info', `intent email sent for ${id}`);
			return { action: 'intent', draft };
		}
		const tweet = await deliverApi(draft, deps);
		await deps.kv.set(key, {
			...pending,
			status: 'sent',
			at: deps.now().toISOString(),
			tweetId: tweet.id,
			tweetUrl: tweet.url,
		} satisfies XAutoRecord);
		deps.log('info', `posted ${id} to X ${tweet.url}`);
		await confirmApi(draft, tweet.url, deps);
		return { action: 'api', draft, tweetUrl: tweet.url };
	} catch (error) {
		if (!(error instanceof XOauth2Error) || error.definitelyNotPosted) {
			await releaseClaim(deps.kv, key);
		}
		const message = error instanceof Error ? error.message : String(error);
		deps.log('error', `x auto post failed for ${id}: ${message}`);
		throw error;
	}
}

async function deliverIntent(draft: XAutoDraft, deps: XAutoDeps): Promise<void> {
	const to = notifyTo(deps.env);
	const message = emailForIntent(draft, deps.now());
	await deps.sendEmail({ to, ...message });
}

async function confirmApi(draft: XAutoDraft, tweetUrl: string, deps: XAutoDeps): Promise<void> {
	try {
		const message = emailForApi(draft, tweetUrl, deps.now());
		await deps.sendEmail({ to: notifyTo(deps.env), ...message });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.log('warn', `X post is live but the confirmation email failed: ${message}`);
	}
}

async function deliverApi(draft: XAutoDraft, deps: XAutoDeps): Promise<{ id: string; url: string }> {
	const config = await currentRefreshToken(deps.kv, deps.env);
	if (!config) {
		throw new XOauth2Error(
			'X API mode is on but X_OAUTH2_CLIENT_ID, X_OAUTH2_CLIENT_SECRET, and a refresh token are not all set. Nothing was posted.',
			true,
		);
	}
	const refreshed = await refreshXUserToken(config, deps.fetch);
	await saveRefreshToken(deps.kv, refreshed.refreshToken, deps.now().toISOString());
	return createXTweet(refreshed.accessToken, draft.text, deps.fetch);
}

export type { XAutoConfiguredMode };
