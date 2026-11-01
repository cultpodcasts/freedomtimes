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
 *
 * Mode (#178, policy.ts `socialShareMode`): production posts to the real
 * accounts with the production secret names; staging posts only to the test
 * accounts with the `*_TEST_*` names, or dry-runs without them; anything else
 * always dry-runs. A dry run builds the exact request, shows it, and sends and
 * records nothing.
 */
import {
	articleUrl,
	EMDASH_ADMIN_ROLE,
	previewFingerprint,
	readSecret,
	SHAREABLE_COLLECTION,
	ShareNetworkError,
	type SharedPost,
	type SharePostSnapshot,
	type SocialShareMode,
	shareRecordKey,
	socialShareMode,
} from './policy';

/** A pending claim older than this is treated as an interrupted attempt. */
export const STALE_PENDING_MS = 2 * 60 * 1000;

export interface ShareDraftBase {
	/** Exact text that will be posted (includes the article link). */
	text: string;
	url: string;
}

/** One social network (Bluesky, X). */
export interface ShareProvider<TConfig, TDraft extends ShareDraftBase> {
	/** KV / action id prefix, e.g. `bluesky`. */
	network: string;
	/** Human name, e.g. `Bluesky`. */
	label: string;
	/** Production Worker secret names, listed in the "not configured" message. */
	secretNames: readonly string[];
	/**
	 * Staging-only test-account secret names, in the same order as
	 * `secretNames` (#178). Staging reads only these; production never does.
	 */
	testSecretNames: readonly string[];
	/** Config from the secret values, in `secretNames` order (all present and non-empty). */
	configFromSecrets(values: readonly string[]): TConfig;
	/** Account shown in the confirm dialog, e.g. `@freedomtimes.news`. */
	accountLabel(config: TConfig): string;
	buildDraft(post: { title: string; description: string; url: string }): TDraft;
	/** Extra preview rows besides the post text (e.g. the link card). */
	previewFields(draft: TDraft): Array<{ label: string; value: string }>;
	publish(config: TConfig, draft: TDraft, deps: { fetch: FetchLike; now: () => Date }): Promise<SharedPost>;
	/** The request `publish` would send to create the post, without credentials (dry-run preview). */
	dryRunRequest(draft: TDraft, now: Date): { method: string; url: string; body: unknown };
	/**
	 * Hand-post fallback. EmDash renders an external block link with
	 * `target="_blank"` (`@emdash-cms/blocks` LinkElementComponent).
	 */
	intentUrl(draft: TDraft): string;
}

/** Where the credentials come from, by mode: none in local, test names on staging, production names in production. */
export function shareSecretNames(provider: Pick<ShareProvider<unknown, ShareDraftBase>, 'secretNames' | 'testSecretNames'>, mode: SocialShareMode): readonly string[] {
	if (mode === 'production') return provider.secretNames;
	if (mode === 'staging') return provider.testSecretNames;
	return [];
}

/**
 * The provider config for this mode, or null. Reads only the names for the
 * mode (so staging never touches a production secret name, and local reads
 * nothing).
 */
export function readShareConfig<TConfig>(
	provider: Pick<ShareProvider<TConfig, ShareDraftBase>, 'secretNames' | 'testSecretNames' | 'configFromSecrets'>,
	env: Record<string, unknown>,
	mode: SocialShareMode,
): TConfig | null {
	const names = shareSecretNames(provider, mode);
	if (names.length === 0) return null;
	const values: string[] = [];
	for (const name of names) {
		const value = readSecret(env, name);
		if (!value) return null;
		values.push(value);
	}
	return provider.configFromSecrets(values);
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

/** Opens the network's compose page in a new tab. Nothing is sent from here. */
function intentLink<TConfig, TDraft extends ShareDraftBase>(provider: ShareProvider<TConfig, TDraft>, draft: TDraft): PanelBlock {
	return {
		type: 'actions',
		elements: [
			{
				type: 'link',
				label: `Open ${provider.label} to post`,
				target: { kind: 'external', url: provider.intentUrl(draft) },
			},
		],
	};
}

function isStalePending(record: ShareRecord, now: Date): boolean {
	const claimed = Date.parse(record.claimedAt);
	return record.status === 'pending' && (Number.isNaN(claimed) || now.getTime() - claimed > STALE_PENDING_MS);
}

type PanelState<TConfig, TDraft extends ShareDraftBase> =
	| { kind: 'blocked'; response: PanelResponse }
	| {
			kind: 'ready';
			mode: SocialShareMode;
			/** Null: dry run (nothing is sent or recorded). */
			config: TConfig | null;
			draft: TDraft;
			fingerprint: string;
			key: string;
			post: SharePostSnapshot;
	  };

function listNames(names: readonly string[]): string {
	return new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
}

/** Banner at the top of every staging / local panel, so nobody mistakes it for production. */
function modeBanner<TConfig, TDraft extends ShareDraftBase>(
	mode: SocialShareMode,
	provider: ShareProvider<TConfig, TDraft>,
	config: TConfig | null,
): PanelBlock | null {
	if (mode === 'production') return null;
	if (mode === 'staging' && config) {
		return banner(
			`Staging: posting to test account ${provider.accountLabel(config)}`,
			`This posts for real, but only to the ${provider.label} test account set in the staging secrets ${listNames(provider.testSecretNames)}. Never the Freedom Times account.`,
			'alert',
		);
	}
	if (mode === 'staging') {
		return banner(
			'Staging: dry run',
			`Nothing is sent to ${provider.label} and nothing is recorded. To post to a test account, set the staging secrets ${listNames(provider.testSecretNames)} (see web/docs/SOCIAL_SHARING.md).`,
		);
	}
	return banner('Local: dry run', `Not staging or production, so nothing is ever sent to ${provider.label} or recorded.`);
}

async function resolveState<TConfig, TDraft extends ShareDraftBase>(
	postId: string,
	req: SharePanelRequest,
	deps: SharePanelDeps<TConfig, TDraft>,
): Promise<PanelState<TConfig, TDraft> & { record?: { value: ShareRecord; revision: string } | null }> {
	const { provider } = deps;
	const blocked = (blocks: PanelBlock[]) => ({ kind: 'blocked' as const, response: { blocks } });

	const hostname = new URL(req.requestUrl).hostname;
	const mode = socialShareMode({ siteAccessMode: deps.env.SITE_ACCESS_MODE, hostname });
	const config = readShareConfig(provider, deps.env, mode);

	if (mode !== 'production' && !config) {
		// Dry run: no secret, no KV, no network. Same draft and checks as a real post.
		const post = await deps.getPost(postId);
		if (!post) throw new ShareAccessError(404, 'NOT_FOUND', 'Post not found.');
		if (post.status !== 'published' || !post.slug) {
			return blocked([{ type: 'context', text: `Publish this post first. Only published posts can be shared to ${provider.label}.` }]);
		}
		const draft = provider.buildDraft({ title: post.title, description: post.description, url: articleUrl(post.slug) });
		const fingerprint = await previewFingerprint(['dry-run', provider.network, post.id, draft.text, ...provider.previewFields(draft).map((f) => f.value)]);
		return { kind: 'ready', mode, config: null, draft, fingerprint, key: '', post, record: null };
	}

	if (!config) {
		const post = await deps.getPost(postId);
		if (!post) throw new ShareAccessError(404, 'NOT_FOUND', 'Post not found.');
		if (post.status !== 'published' || !post.slug) {
			return blocked([{ type: 'context', text: `Publish this post first. Only published posts can be shared to ${provider.label}.` }]);
		}
		const draft = provider.buildDraft({ title: post.title, description: post.description, url: articleUrl(post.slug) });
		return blocked([
			banner(
				`${provider.label} sharing isn't configured`,
				`Set the Worker secrets ${new Intl.ListFormat('en', { type: 'conjunction' }).format(provider.secretNames)} on the production Worker (see web/docs/SOCIAL_SHARING.md). Until then, open ${provider.label} and press Post yourself. Publishing does not email anyone.`,
				'alert',
			),
			{ type: 'context', text: 'Post text, exactly as it will be posted:' },
			{ type: 'code', code: draft.text },
			intentLink(provider, draft),
		]);
	}

	const key = shareRecordKey(provider.network, postId, mode);
	const record = await deps.kv.getVersioned<ShareRecord>(key);
	/** Where a real post goes: the test account on staging, the network itself in production. */
	const target = mode === 'staging' ? `the ${provider.label} test account` : provider.label;

	if (record?.value.status === 'posted') {
		const r = record.value;
		const blocks: PanelBlock[] = [
			banner(
				`Shared to ${target}`,
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
					`${r.claimedBy} tried to post on ${ukTime(r.claimedAt)}${r.error ? ` (${r.error})` : ''}. Check ${target === provider.label ? `the ${provider.label} profile` : `${target}'s profile`} first. If the post isn't there, release the lock to try again.`,
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
			...blocked([banner('Posting in progress', `${record.value.claimedBy} is posting this to ${target} right now.`)]),
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
	return { kind: 'ready', mode, config, draft, fingerprint, key, post, record: null };
}

function readyBlocks<TConfig, TDraft extends ShareDraftBase>(
	state: Extract<PanelState<TConfig, TDraft>, { kind: 'ready' }>,
	provider: ShareProvider<TConfig, TDraft>,
	now: Date,
): PanelBlock[] {
	const extra = provider.previewFields(state.draft);
	const preview: PanelBlock[] = [
		// A code block keeps line breaks and never truncates (a fields value is one truncated line).
		{ type: 'context', text: 'Post text, exactly as it will be posted:' },
		{ type: 'code', code: state.draft.text },
		...(extra.length > 0 ? [{ type: 'fields', fields: extra }] : []),
	];
	if (!state.config) {
		const request = provider.dryRunRequest(state.draft, now);
		return [
			{
				type: 'context',
				text: `Dry run. Pressing the button builds the post again and shows it here. Nothing is sent to ${provider.label} and nothing is recorded.`,
			},
			...preview,
			{ type: 'context', text: `Request a real post would send (${request.method} ${request.url}; credentials left out):` },
			{ type: 'code', code: JSON.stringify(request.body, null, 2) },
			{
				type: 'actions',
				elements: [
					{
						type: 'button',
						action_id: `${provider.network}_post`,
						label: `Dry run: Post to ${provider.label}`,
						style: 'primary',
						value: state.fingerprint,
					},
					{
						type: 'link',
						label: `Open ${provider.label} to post`,
						target: { kind: 'external', url: provider.intentUrl(state.draft) },
					},
				],
			},
		];
	}
	const account = provider.accountLabel(state.config);
	const testAccount = state.mode === 'staging';
	const who = testAccount ? `the test account ${account}` : account;
	return [
		{ type: 'context', text: `Preview. Nothing is posted until you press the button and confirm. Posts as ${who}.` },
		...preview,
		{
			type: 'actions',
			elements: [
				{
					type: 'button',
					action_id: `${provider.network}_post`,
					label: testAccount ? `Post to ${provider.label} test account` : `Post to ${provider.label}`,
					style: 'primary',
					value: state.fingerprint,
					confirm: {
						title: `Post to ${provider.label} as ${who}?`,
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
	const mode = socialShareMode({ siteAccessMode: deps.env.SITE_ACCESS_MODE, hostname: new URL(req.requestUrl).hostname });
	const top = modeBanner(mode, provider, readShareConfig(provider, deps.env, mode));
	const respond = (blocks: PanelBlock[], toast?: PanelResponse['toast']): PanelResponse => {
		const all = top ? [top, ...blocks] : blocks;
		return toast ? { blocks: all, toast } : { blocks: all };
	};
	const blocksOf = (state: PanelState<TConfig, TDraft>) =>
		state.kind === 'ready' ? readyBlocks(state, provider, deps.now()) : state.response.blocks;

	const render = async (toast?: PanelResponse['toast']): Promise<PanelResponse> =>
		respond(blocksOf(await resolveState(postId, req, deps)), toast);

	if (action === `${provider.network}_release`) {
		const state = await resolveState(postId, req, deps);
		const record = state.record;
		const releasable =
			record && (record.value.status === 'uncertain' || isStalePending(record.value, deps.now()));
		if (!record || !releasable) return render({ message: 'Nothing to release.', type: 'info' });
		await deps.kv.compareAndDelete(shareRecordKey(provider.network, postId, mode), record.revision);
		return render({ message: 'Lock released. Check the preview before posting again.', type: 'info' });
	}

	if (action !== `${provider.network}_post`) return render();

	// Re-check everything server-side at click time; the button value is only a preview fingerprint.
	const state = await resolveState(postId, req, deps);
	if (state.kind !== 'ready') {
		return respond(state.response.blocks, { message: `Not posted to ${provider.label}.`, type: 'error' });
	}
	if (input.value !== state.fingerprint) {
		return respond(blocksOf(state), {
			message: 'The post changed since the preview. Check the new preview, then post again.',
			type: 'error',
		});
	}

	if (!state.config) {
		// Dry run: no claim, no record, no network call.
		return respond(blocksOf(state), {
			message: `Dry run: built the ${provider.label} post shown here. Nothing was sent and nothing was recorded.`,
			type: 'info',
		});
	}
	const config = state.config;

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

	const where = state.mode === 'staging' ? `the ${provider.label} test account` : provider.label;
	try {
		const shared = await provider.publish(config, state.draft, { fetch: deps.fetch, now: deps.now });
		const posted: ShareRecord = {
			...pending,
			status: 'posted',
			postedAt: deps.now().toISOString(),
			remoteId: shared.id,
			remoteUrl: shared.url,
		};
		const saved = await deps.kv.compareAndSet(state.key, claim.revision, posted);
		if (!saved.applied) await deps.kv.set(state.key, posted);
		return render({ message: `Posted to ${where}.`, type: 'success' });
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
