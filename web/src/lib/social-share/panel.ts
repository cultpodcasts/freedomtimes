/**
 * Block Kit panel logic for the admin-only "Post to …" editor panels.
 *
 * Runs only inside the EmDash admin post editor: the plugin route is private
 * (EmDash enforces session auth, the `plugins:manage` = Admin permission and
 * the `X-EmDash-Request` CSRF header before this runs), and this handler
 * re-checks the Admin role and the host-attested editor-panel context itself.
 *
 * Nothing posts on load. A post goes out only when an admin presses the
 * button and confirms the dialog showing the exact text and link. The share
 * is recorded in plugin KV (claimed atomically first), so the same post can't
 * be shared twice to the same network. Dependencies are injected so
 * scripts/test-social-share.mts can drive every state with mocks.
 */
import {
	articleUrl,
	EMDASH_ADMIN_ROLE,
	isSocialShareEnvironment,
	previewFingerprint,
	SHAREABLE_COLLECTION,
	ShareNetworkError,
	type SharedPost,
	type SharePostSnapshot,
	shareRecordKey,
} from './policy';

/** A pending claim older than this is treated as an interrupted attempt. */
export const STALE_PENDING_MS = 2 * 60 * 1000;

export interface ShareDraftBase {
	/** Exact text that will be posted (includes the article link). */
	text: string;
	url: string;
}

/** One social network (Bluesky in #21, X in #20). */
export interface ShareProvider<TConfig, TDraft extends ShareDraftBase> {
	/** KV / action id prefix, e.g. `bluesky`. */
	network: string;
	/** Human name, e.g. `Bluesky`. */
	label: string;
	/** Worker secret names, listed in the "not configured" message. */
	secretNames: readonly string[];
	readConfig(env: Record<string, unknown>): TConfig | null;
	/** Account shown in the confirm dialog, e.g. `@freedomtimes.news`. */
	accountLabel(config: TConfig): string;
	buildDraft(post: { title: string; description: string; url: string }): TDraft;
	/** Extra preview rows besides the post text (e.g. the link card). */
	previewFields(draft: TDraft): Array<{ label: string; value: string }>;
	publish(config: TConfig, draft: TDraft, deps: { fetch: FetchLike; now: () => Date }): Promise<SharedPost>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ShareRecord {
	network: string;
	postId: string;
	status: 'pending' | 'uncertain' | 'posted';
	text: string;
	claimedAt: string;
	claimedBy: string;
	postedAt?: string;
	remoteId?: string;
	remoteUrl?: string;
	error?: string;
}

/** The plugin KV methods this needs (EmDash `ctx.kv`). */
export interface ShareKv {
	getVersioned<T>(key: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet(
		key: string,
		expectedRevision: string | null,
		value: unknown,
	): Promise<{ applied: true; revision: string } | { applied: false }>;
	compareAndDelete(key: string, expectedRevision: string): Promise<{ applied: boolean }>;
	set(key: string, value: unknown): Promise<void>;
}

export interface ShareUser {
	id: string;
	email?: string;
	name?: string | null;
	role: number;
}

/** Thrown for requests that must be refused; the plugin maps it to an HTTP error. */
export class ShareAccessError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ShareAccessError';
		this.status = status;
		this.code = code;
	}
}

export type PanelBlock = Record<string, unknown> & { type: string };
export interface PanelResponse {
	blocks: PanelBlock[];
	toast?: { message: string; type: 'success' | 'error' | 'info' };
}

export interface SharePanelRequest {
	input: unknown;
	ui: unknown;
	user: ShareUser | undefined;
	requestUrl: string;
}

export interface SharePanelDeps<TConfig, TDraft extends ShareDraftBase> {
	provider: ShareProvider<TConfig, TDraft>;
	env: Record<string, unknown>;
	kv: ShareKv;
	getPost(id: string): Promise<SharePostSnapshot | null>;
	fetch: FetchLike;
	now: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Admin only, and only from the host-attested post editor panel. */
export function assertSharePanelAccess(req: Pick<SharePanelRequest, 'ui' | 'user'>): { postId: string } {
	if (!req.user) throw new ShareAccessError(401, 'UNAUTHORIZED', 'Sign in to the EmDash admin.');
	if (typeof req.user.role !== 'number' || req.user.role < EMDASH_ADMIN_ROLE) {
		throw new ShareAccessError(403, 'FORBIDDEN', 'Only admins can share posts.');
	}
	const ui = req.ui;
	if (!isRecord(ui) || ui.surface !== 'content-editor-panel' || !isRecord(ui.entry)) {
		throw new ShareAccessError(403, 'EDITOR_PANEL_ONLY', 'Open this from the post editor in the EmDash admin.');
	}
	const entry = ui.entry;
	if (entry.collection !== SHAREABLE_COLLECTION || typeof entry.id !== 'string' || entry.id.length === 0) {
		throw new ShareAccessError(400, 'NOT_A_POST', 'Only posts can be shared.');
	}
	return { postId: entry.id };
}

const UK_TIME = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/London',
	dateStyle: 'medium',
	timeStyle: 'short',
});

function ukTime(iso: string | undefined): string {
	if (!iso) return 'an unknown time';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? 'an unknown time' : `${UK_TIME.format(d)} (UK time)`;
}

function userLabel(user: ShareUser): string {
	return user.name?.trim() || user.email?.trim() || user.id;
}

function banner(title: string, description: string, variant: 'default' | 'alert' | 'error' = 'default'): PanelBlock {
	return { type: 'banner', title, description, variant };
}

function isStalePending(record: ShareRecord, now: Date): boolean {
	const claimed = Date.parse(record.claimedAt);
	return record.status === 'pending' && (Number.isNaN(claimed) || now.getTime() - claimed > STALE_PENDING_MS);
}

type PanelState<TConfig, TDraft extends ShareDraftBase> =
	| { kind: 'blocked'; response: PanelResponse }
	| {
			kind: 'ready';
			config: TConfig;
			draft: TDraft;
			fingerprint: string;
			key: string;
			post: SharePostSnapshot;
	  };

async function resolveState<TConfig, TDraft extends ShareDraftBase>(
	postId: string,
	req: SharePanelRequest,
	deps: SharePanelDeps<TConfig, TDraft>,
): Promise<PanelState<TConfig, TDraft> & { record?: { value: ShareRecord; revision: string } | null }> {
	const { provider } = deps;
	const blocked = (blocks: PanelBlock[]) => ({ kind: 'blocked' as const, response: { blocks } });

	const hostname = new URL(req.requestUrl).hostname;
	if (!isSocialShareEnvironment({ siteAccessMode: deps.env.SITE_ACCESS_MODE, hostname })) {
		return blocked([
			banner(
				'Disabled outside production',
				`Posting to ${provider.label} only works in the production admin (freedomtimes.news). Staging and local sites can never post to the real accounts.`,
			),
		]);
	}

	const config = provider.readConfig(deps.env);
	if (!config) {
		return blocked([
			banner(
				`${provider.label} sharing isn't configured`,
				`Set the Worker secrets ${provider.secretNames.join(' and ')} on the production Worker (see web/docs/SOCIAL_SHARING.md). Nothing can be posted until then.`,
				'alert',
			),
		]);
	}

	const key = shareRecordKey(provider.network, postId);
	const record = await deps.kv.getVersioned<ShareRecord>(key);
	if (record?.value.status === 'posted') {
		const r = record.value;
		const blocks: PanelBlock[] = [
			banner(
				`Shared to ${provider.label}`,
				`Posted on ${ukTime(r.postedAt)} by ${r.claimedBy}. A post can only be shared once per network.`,
			),
		];
		if (r.remoteUrl) {
			blocks.push({
				type: 'actions',
				elements: [{ type: 'link', label: `Open on ${provider.label}`, target: { kind: 'external', url: r.remoteUrl } }],
			});
		}
		return { ...blocked(blocks), record };
	}
	if (record && (record.value.status === 'uncertain' || isStalePending(record.value, deps.now()))) {
		const r = record.value;
		return {
			...blocked([
				banner(
					'Last attempt may or may not have posted',
					`${r.claimedBy} tried to post on ${ukTime(r.claimedAt)}${r.error ? ` (${r.error})` : ''}. Check the ${provider.label} profile first. If the post isn't there, release the lock to try again.`,
					'error',
				),
				{
					type: 'actions',
					elements: [
						{
							type: 'button',
							action_id: `${provider.network}_release`,
							label: 'Release lock',
							style: 'danger',
							confirm: {
								title: 'Release the share lock?',
								text: `Only do this if you checked ${provider.label} and the post is not there. Otherwise it will be posted twice.`,
								confirm: 'Release',
								deny: 'Cancel',
								style: 'danger',
							},
						},
					],
				},
			]),
			record,
		};
	}
	if (record) {
		return {
			...blocked([banner('Posting in progress', `${record.value.claimedBy} is posting this to ${provider.label} right now.`)]),
			record,
		};
	}

	const post = await deps.getPost(postId);
	if (!post) throw new ShareAccessError(404, 'NOT_FOUND', 'Post not found.');
	if (post.status !== 'published' || !post.slug) {
		return blocked([{ type: 'context', text: `Publish this post first. Only published posts can be shared to ${provider.label}.` }]);
	}

	const draft = provider.buildDraft({ title: post.title, description: post.description, url: articleUrl(post.slug) });
	const fingerprint = await previewFingerprint([provider.network, post.id, draft.text, ...provider.previewFields(draft).map((f) => f.value)]);
	return { kind: 'ready', config, draft, fingerprint, key, post, record: null };
}

function readyBlocks<TConfig, TDraft extends ShareDraftBase>(
	state: Extract<PanelState<TConfig, TDraft>, { kind: 'ready' }>,
	provider: ShareProvider<TConfig, TDraft>,
): PanelBlock[] {
	const account = provider.accountLabel(state.config);
	return [
		{ type: 'context', text: `Preview. Nothing is posted until you press the button and confirm. Posts as ${account}.` },
		{ type: 'fields', fields: [{ label: 'Post text', value: state.draft.text }, ...provider.previewFields(state.draft)] },
		{
			type: 'actions',
			elements: [
				{
					type: 'button',
					action_id: `${provider.network}_post`,
					label: `Post to ${provider.label}`,
					style: 'primary',
					value: state.fingerprint,
					confirm: {
						title: `Post to ${provider.label} as ${account}?`,
						text: `This posts publicly, once:\n\n${state.draft.text}`,
						confirm: 'Post',
						deny: 'Cancel',
					},
				},
			],
		},
	];
}

/** Handle one panel interaction (`panel_load` or a button `block_action`). */
export async function handleSharePanel<TConfig, TDraft extends ShareDraftBase>(
	req: SharePanelRequest,
	deps: SharePanelDeps<TConfig, TDraft>,
): Promise<PanelResponse> {
	const { postId } = assertSharePanelAccess(req);
	const user = req.user as ShareUser;
	const { provider } = deps;
	const input = isRecord(req.input) ? req.input : {};
	const action = input.type === 'block_action' && typeof input.action_id === 'string' ? input.action_id : null;

	const render = async (toast?: PanelResponse['toast']): Promise<PanelResponse> => {
		const state = await resolveState(postId, req, deps);
		const blocks = state.kind === 'ready' ? readyBlocks(state, provider) : state.response.blocks;
		return toast ? { blocks, toast } : { blocks };
	};

	if (action === `${provider.network}_release`) {
		const state = await resolveState(postId, req, deps);
		const record = state.record;
		const releasable =
			record && (record.value.status === 'uncertain' || isStalePending(record.value, deps.now()));
		if (!record || !releasable) return render({ message: 'Nothing to release.', type: 'info' });
		await deps.kv.compareAndDelete(shareRecordKey(provider.network, postId), record.revision);
		return render({ message: 'Lock released. Check the preview before posting again.', type: 'info' });
	}

	if (action !== `${provider.network}_post`) return render();

	// Re-check everything server-side at click time; the button value is only a preview fingerprint.
	const state = await resolveState(postId, req, deps);
	if (state.kind !== 'ready') {
		return { ...state.response, toast: { message: `Not posted to ${provider.label}.`, type: 'error' } };
	}
	if (input.value !== state.fingerprint) {
		return {
			blocks: readyBlocks(state, provider),
			toast: { message: 'The post changed since the preview. Check the new preview, then post again.', type: 'error' },
		};
	}

	const claimedAt = deps.now().toISOString();
	const pending: ShareRecord = {
		network: provider.network,
		postId,
		status: 'pending',
		text: state.draft.text,
		claimedAt,
		claimedBy: userLabel(user),
	};
	const claim = await deps.kv.compareAndSet(state.key, null, pending);
	if (!claim.applied) {
		return render({ message: `Already shared (or being shared) to ${provider.label}.`, type: 'info' });
	}

	try {
		const shared = await provider.publish(state.config, state.draft, { fetch: deps.fetch, now: deps.now });
		const posted: ShareRecord = {
			...pending,
			status: 'posted',
			postedAt: deps.now().toISOString(),
			remoteId: shared.id,
			remoteUrl: shared.url,
		};
		const saved = await deps.kv.compareAndSet(state.key, claim.revision, posted);
		if (!saved.applied) await deps.kv.set(state.key, posted);
		return render({ message: `Posted to ${provider.label}.`, type: 'success' });
	} catch (error) {
		const message = error instanceof Error ? error.message : `Posting to ${provider.label} failed.`;
		if (error instanceof ShareNetworkError && error.definitelyNotPosted) {
			await deps.kv.compareAndDelete(state.key, claim.revision);
			return render({ message: `Not posted: ${message}`, type: 'error' });
		}
		await deps.kv.compareAndSet(state.key, claim.revision, { ...pending, status: 'uncertain', error: message });
		return render({ message, type: 'error' });
	}
}
