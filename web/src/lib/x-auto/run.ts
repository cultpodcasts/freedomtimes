/**
 * What happens when a post is published.
 *
 * Production with X_AUTO_POST_MODE=api posts to X and to Bluesky through the
 * same clients, drafts, and KV keys as the admin panels, when that network's
 * secrets are set. A network without secrets is skipped: the post editor
 * shows an intent link instead. Nothing is emailed. Staging, local, and any
 * Worker without X_AUTO_POST_ALLOW_SEND=yes dry-run: they log both intent
 * links and send nothing. A posted network is recorded on the same KV key as
 * the panel, so a republish does not post again.
 */
import { blueskyProvider } from '../social-share/bluesky.ts';
import type { FetchLike, ShareDraftBase, ShareKv, ShareProvider, ShareRecord } from '../social-share/panel.ts';
import { readShareConfig } from '../social-share/panel.ts';
import { articleUrl, graphemeLength, ShareNetworkError, shareRecordKey, snapshotFromContentItem } from '../social-share/policy.ts';
import { xProvider } from '../social-share/x.ts';
import { effectiveXAutoMode } from './mode.ts';

/** How long a crashed attempt blocks a retry. After this, a republish can try again. */
export const X_AUTO_STALE_PENDING_MS = 2 * 60 * 1000;

export interface SocialAutoNetworkResult {
	network: string;
	action: 'dry-run' | 'posted' | 'skipped' | 'failed';
	reason?: string;
	text?: string;
	intentUrl?: string;
	remoteUrl?: string;
}

export interface XAutoResult {
	action: 'skip' | 'dry-run' | 'api';
	reason?: string;
	networks: SocialAutoNetworkResult[];
}

export interface XAutoDeps {
	env: Record<string, unknown>;
	kv: ShareKv;
	now: () => Date;
	fetch: FetchLike;
	log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function isShareRecord(value: unknown): value is ShareRecord {
	if (typeof value !== 'object' || value === null) return false;
	const status = (value as { status?: unknown }).status;
	return status === 'pending' || status === 'uncertain' || status === 'posted';
}

function lengthLabel(network: string, draft: ShareDraftBase): string {
	if (network === 'x' && 'weightedLength' in draft && typeof draft.weightedLength === 'number') {
		return `${draft.weightedLength} weighted`;
	}
	return `${graphemeLength(draft.text)} chars`;
}

async function releaseClaim(kv: ShareKv, key: string): Promise<void> {
	const current = await kv.getVersioned<ShareRecord>(key);
	if (!current) return;
	await kv.compareAndDelete(key, current.revision);
}

/**
 * Handle one publish. Safe to call from the EmDash afterPublish hook.
 * One network failing does not stop the other. Never emails.
 */
export async function handleXAutoPublish(
	content: Record<string, unknown>,
	collection: string,
	deps: XAutoDeps,
): Promise<XAutoResult> {
	if (collection !== 'posts') return { action: 'skip', reason: 'not-a-post', networks: [] };

	const mode = effectiveXAutoMode(deps.env);
	if (mode === 'off') return { action: 'skip', reason: 'off', networks: [] };

	const data = content.data && typeof content.data === 'object' ? (content.data as Record<string, unknown>) : {};
	const seo = content.seo && typeof content.seo === 'object'
		? (content.seo as { title?: string | null; description?: string | null })
		: null;
	const id = typeof content.id === 'string' ? content.id : '';
	const slug = typeof content.slug === 'string' ? content.slug : null;
	const status = typeof content.status === 'string' ? content.status : '';
	if (!id || !slug || status !== 'published') {
		return { action: 'skip', reason: 'not-a-published-post', networks: [] };
	}

	const snapshot = snapshotFromContentItem({ id, slug, status, data, seo });
	if (!snapshot.title) return { action: 'skip', reason: 'no-headline', networks: [] };

	const input = { title: snapshot.title, description: snapshot.description, url: articleUrl(slug) };
	const networks = [
		await runNetwork(xProvider, id, input, mode, deps),
		await runNetwork(blueskyProvider, id, input, mode, deps),
	];

	return { action: mode === 'dry-run' ? 'dry-run' : 'api', networks };
}

async function runNetwork<TConfig, TDraft extends ShareDraftBase>(
	provider: ShareProvider<TConfig, TDraft>,
	postId: string,
	post: { title: string; description: string; url: string },
	mode: 'dry-run' | 'api',
	deps: XAutoDeps,
): Promise<SocialAutoNetworkResult> {
	const draft = provider.buildDraft(post);
	if (mode === 'dry-run') {
		const intentUrl = provider.intentUrl(draft);
		deps.log('info', `dry-run ${provider.network} ${postId} (${lengthLabel(provider.network, draft)}) ${intentUrl}`);
		return { network: provider.network, action: 'dry-run', text: draft.text, intentUrl };
	}
	return postNetwork(provider, postId, draft, deps);
}

async function postNetwork<TConfig, TDraft extends ShareDraftBase>(
	provider: ShareProvider<TConfig, TDraft>,
	postId: string,
	draft: TDraft,
	deps: XAutoDeps,
): Promise<SocialAutoNetworkResult> {
	const config = readShareConfig(provider, deps.env, 'production');
	if (!config) {
		deps.log('info', `${provider.network} ${postId} not configured; the post editor has the intent link`);
		return {
			network: provider.network,
			action: 'skipped',
			reason: 'not-configured',
			text: draft.text,
			intentUrl: provider.intentUrl(draft),
		};
	}

	const key = shareRecordKey(provider.network, postId, 'production');
	const existing = await deps.kv.getVersioned<unknown>(key);
	const record = existing && isShareRecord(existing.value) ? existing.value : null;
	if (record?.status === 'posted') {
		return { network: provider.network, action: 'skipped', reason: 'already-posted', remoteUrl: record.remoteUrl, text: draft.text };
	}
	if (record && (record.status === 'pending' || record.status === 'uncertain')) {
		const age = deps.now().getTime() - Date.parse(record.claimedAt);
		if (!Number.isFinite(age) || age < X_AUTO_STALE_PENDING_MS) {
			return { network: provider.network, action: 'skipped', reason: 'in-progress', text: draft.text };
		}
	}

	const pending: ShareRecord = {
		network: provider.network,
		postId,
		status: 'pending',
		text: draft.text,
		claimedAt: deps.now().toISOString(),
		claimedBy: 'publish',
	};
	const claim = await deps.kv.compareAndSet(key, existing?.revision ?? null, pending);
	if (!claim.applied) return { network: provider.network, action: 'skipped', reason: 'lost-race', text: draft.text };

	try {
		const shared = await provider.publish(config, draft, { fetch: deps.fetch, now: deps.now });
		const posted: ShareRecord = {
			...pending,
			status: 'posted',
			postedAt: deps.now().toISOString(),
			remoteId: shared.id,
			remoteUrl: shared.url,
		};
		const saved = await deps.kv.compareAndSet(key, claim.revision, posted);
		if (!saved.applied) await deps.kv.set(key, posted);
		deps.log('info', `posted ${provider.network} ${postId} ${shared.url}`);
		return { network: provider.network, action: 'posted', text: draft.text, remoteUrl: shared.url, intentUrl: provider.intentUrl(draft) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof ShareNetworkError && error.definitelyNotPosted) {
			await releaseClaim(deps.kv, key);
		} else {
			await deps.kv.compareAndSet(key, claim.revision, { ...pending, status: 'uncertain', error: message });
		}
		deps.log('error', `${provider.network} auto post failed for ${postId}: ${message}`);
		return { network: provider.network, action: 'failed', reason: message, text: draft.text, intentUrl: provider.intentUrl(draft) };
	}
}
