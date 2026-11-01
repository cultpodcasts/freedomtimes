/**
 * Admin-only "Post to Bluesky" (#21) and "Post to X" (#20) panels: clients,
 * panel states, double-post lock and admin-only placement. Every network call is mocked;
 * nothing here can reach a real account.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { isCacheablePath } from '../src/lib/page-cache-policy.ts';
import { SOCIAL_SHARE_ALLOWED_HOSTS, SOCIAL_SHARE_CAPABILITIES } from '../src/lib/social-share/manifest.ts';
import {
	BLUESKY_MAX_GRAPHEMES,
	blueskyProvider,
	BLUESKY_SECRET_NAMES,
	BLUESKY_TEST_SECRET_NAMES,
	blueskyWebUrl,
	buildBlueskyDraft,
	buildBlueskyRecord,
	postToBluesky,
	readBlueskyConfig,
	utf8ByteRange,
} from '../src/lib/social-share/bluesky.ts';
import {
	assertSharePanelAccess,
	handleSharePanel,
	readShareConfig,
	ShareAccessError,
	shareSecretNames,
	type ShareKv,
	type SharePanelDeps,
	STALE_PENDING_MS,
} from '../src/lib/social-share/panel.ts';
import {
	articleUrl,
	graphemeLength,
	isSocialShareEnvironment,
	ShareNetworkError,
	shareRecordKey,
	snapshotFromContentItem,
	socialShareMode,
	type SharePostSnapshot,
	truncateGraphemes,
} from '../src/lib/social-share/policy.ts';
import {
	buildXDraft,
	oauth1Header,
	oauth1Signature,
	oauthPercentEncode,
	postToX,
	readXConfig,
	truncateXWeighted,
	X_MAX_WEIGHTED_LENGTH,
	X_SECRET_NAMES,
	X_TEST_SECRET_NAMES,
	xAccountLabel,
	xProvider,
	xTextWeight,
	xWeightedLength,
} from '../src/lib/social-share/x.ts';

const PROD_URL = 'https://freedomtimes.news/_emdash/api/content/posts/p1/extensions/panel/ft-social-share/bluesky';
const STAGING_URL = 'https://staging.freedomtimes.news/_emdash/api/content/posts/p1/extensions/panel/ft-social-share/bluesky';
const PROD_ENV = { SITE_ACCESS_MODE: 'public', BLUESKY_HANDLE: '@freedomtimes.news', BLUESKY_APP_PASSWORD: 'test-app-pass' };
const ADMIN = { id: 'u1', email: 'admin@example.test', name: 'Ada Admin', role: 50 };
const PANEL_UI = { surface: 'content-editor-panel', locale: 'en', direction: 'ltr', extensionId: 'bluesky', entry: { collection: 'posts', id: 'p1', locale: null, version: 3 } };
const POST: SharePostSnapshot = { id: 'p1', slug: 'cult-news-weekly', status: 'published', title: 'Cult news this week', description: 'The week in review.' };

/** In-memory plugin KV with EmDash's revision semantics. */
class FakeKv implements ShareKv {
	data = new Map<string, { value: unknown; revision: string }>();
	private n = 0;
	async getVersioned<T>(key: string) {
		const hit = this.data.get(key);
		return hit ? { value: structuredClone(hit.value) as T, revision: hit.revision } : null;
	}
	async compareAndSet(key: string, expected: string | null, value: unknown) {
		const hit = this.data.get(key);
		if ((hit?.revision ?? null) !== expected) return { applied: false as const };
		const revision = `r${++this.n}`;
		this.data.set(key, { value: structuredClone(value), revision });
		return { applied: true as const, revision };
	}
	async compareAndDelete(key: string, expected: string) {
		if (this.data.get(key)?.revision !== expected) return { applied: false };
		this.data.delete(key);
		return { applied: true };
	}
	async set(key: string, value: unknown) {
		this.data.set(key, { value: structuredClone(value), revision: `r${++this.n}` });
	}
}

type Call = { url: string; init?: RequestInit };

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Mock Bluesky: createSession then createRecord, with optional overrides. */
function mockBluesky(over: { session?: () => Response; create?: () => Response | Promise<Response> } = {}) {
	const calls: Call[] = [];
	const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		if (url.endsWith('/com.atproto.server.createSession')) {
			return over.session ? over.session() : json(200, { accessJwt: 'jwt-1', did: 'did:plc:abc123', handle: 'freedomtimes.news' });
		}
		if (url.endsWith('/com.atproto.repo.createRecord')) {
			return over.create ? over.create() : json(200, { uri: 'at://did:plc:abc123/app.bsky.feed.post/3kxyz', cid: 'bafy' });
		}
		throw new Error(`unexpected fetch ${url}`);
	};
	return { calls, fetch, creates: () => calls.filter((c) => c.url.endsWith('createRecord')).length };
}

function harness(over: Partial<SharePanelDeps<unknown, never>> & { post?: SharePostSnapshot | null; now?: () => Date } = {}) {
	const kv = new FakeKv();
	const bsky = mockBluesky();
	const deps = {
		provider: blueskyProvider,
		env: PROD_ENV as Record<string, unknown>,
		kv,
		getPost: async () => (over.post === undefined ? POST : over.post),
		fetch: bsky.fetch,
		now: over.now ?? (() => new Date('2026-10-31T22:45:00Z')),
		...over,
	} as SharePanelDeps<never, never>;
	return { deps, kv, bsky };
}

const load = (deps: SharePanelDeps<never, never>, opts: { user?: unknown; ui?: unknown; url?: string } = {}) =>
	handleSharePanel(
		{ input: { type: 'panel_load' }, ui: 'ui' in opts ? opts.ui : PANEL_UI, user: ('user' in opts ? opts.user : ADMIN) as never, requestUrl: opts.url ?? PROD_URL },
		deps,
	);
const act = (deps: SharePanelDeps<never, never>, action_id: string, value?: unknown, url = PROD_URL) =>
	handleSharePanel({ input: { type: 'block_action', action_id, value }, ui: PANEL_UI, user: ADMIN, requestUrl: url }, deps);

function findButton(blocks: Array<Record<string, unknown>>, actionId: string) {
	for (const b of blocks) {
		for (const el of (b.elements as Array<Record<string, unknown>> | undefined) ?? []) {
			if (el.type === 'button' && el.action_id === actionId) return el;
		}
	}
	return undefined;
}

function findExternalLink(blocks: Array<Record<string, unknown>>) {
	for (const b of blocks) {
		for (const el of (b.elements as Array<Record<string, unknown>> | undefined) ?? []) {
			if (el.type === 'link') return el;
		}
	}
	return undefined;
}

describe('social share policy', () => {
	it('only the production Worker on a production host can share', () => {
		assert.equal(isSocialShareEnvironment({ siteAccessMode: 'public', hostname: 'freedomtimes.news' }), true);
		assert.equal(isSocialShareEnvironment({ siteAccessMode: 'public', hostname: 'www.freedomtimes.news' }), true);
		assert.equal(isSocialShareEnvironment({ siteAccessMode: 'locked', hostname: 'freedomtimes.news' }), false);
		assert.equal(isSocialShareEnvironment({ siteAccessMode: 'locked', hostname: 'staging.freedomtimes.news' }), false);
		assert.equal(isSocialShareEnvironment({ siteAccessMode: 'public', hostname: 'staging.freedomtimes.news' }), false);
		assert.equal(isSocialShareEnvironment({ siteAccessMode: 'public', hostname: 'localhost' }), false);
		assert.equal(isSocialShareEnvironment({ siteAccessMode: undefined, hostname: 'freedomtimes.news' }), false);
	});

	it('links the production article URL', () => {
		assert.equal(articleUrl('cult-news-weekly'), 'https://freedomtimes.news/posts/cult-news-weekly');
	});

	it('counts and truncates graphemes, not code units', () => {
		assert.equal(graphemeLength('👩‍👩‍👧 é'), 3);
		assert.equal(truncateGraphemes('abcdef', 4), 'abc…');
		assert.equal(truncateGraphemes('abc', 4), 'abc');
	});

	it('picks title and description like the article page', () => {
		const snap = snapshotFromContentItem({
			id: 'p1',
			slug: 's',
			status: 'published',
			data: { title: 'Title', social_title: '  Social  title ', lede: 'Lede' },
			seo: { title: 'SEO', description: null },
		});
		assert.equal(snap.title, 'Social title');
		assert.equal(snap.description, 'Lede');
		const fallback = snapshotFromContentItem({ id: 'p1', slug: 's', status: 'draft', data: { title: 'Title' }, seo: { title: null, description: 'SEO desc' } });
		assert.equal(fallback.title, 'Title');
		assert.equal(fallback.description, 'SEO desc');
	});
});

describe('Bluesky client (mocked)', () => {
	it('needs both secrets', () => {
		assert.equal(readBlueskyConfig({}), null);
		assert.equal(readBlueskyConfig({ BLUESKY_HANDLE: 'a.bsky.social', BLUESKY_APP_PASSWORD: '  ' }), null);
		assert.deepEqual(readBlueskyConfig({ BLUESKY_HANDLE: ' @a.bsky.social ', BLUESKY_APP_PASSWORD: 'x' }), { handle: 'a.bsky.social', appPassword: 'x' });
	});

	it('keeps the text within 300 graphemes and always ends with the full link', () => {
		const url = articleUrl('a-very-long-slug');
		const draft = buildBlueskyDraft({ title: '“Quoted” 🚨 '.repeat(60), description: 'd', url });
		assert.ok(graphemeLength(draft.text) <= BLUESKY_MAX_GRAPHEMES);
		assert.ok(draft.text.endsWith(`\n\n${url}`));
		assert.ok(draft.text.includes('…'));
	});

	it('indexes the link facet by UTF-8 bytes', () => {
		const url = articleUrl('slug');
		const draft = buildBlueskyDraft({ title: 'Café “news” 🚨', description: 'About it', url });
		const record = buildBlueskyRecord(draft, new Date('2026-10-31T22:00:00Z')) as {
			text: string;
			facets: Array<{ index: { byteStart: number; byteEnd: number }; features: Array<{ $type: string; uri: string }> }>;
			embed: { $type: string; external: { uri: string; title: string; description: string } };
		};
		const bytes = new TextEncoder().encode(record.text);
		const { byteStart, byteEnd } = record.facets[0].index;
		assert.equal(new TextDecoder().decode(bytes.slice(byteStart, byteEnd)), url);
		assert.notEqual(byteStart, record.text.indexOf(url), 'multi-byte title shifts byte offsets');
		assert.equal(record.facets[0].features[0].$type, 'app.bsky.richtext.facet#link');
		assert.deepEqual(record.embed, { $type: 'app.bsky.embed.external', external: { uri: url, title: 'Café “news” 🚨', description: 'About it' } });
		assert.equal(utf8ByteRange('abc', 'zzz'), null);
	});

	it('signs in with the app password, then creates the post on bsky.social only', async () => {
		const bsky = mockBluesky();
		const draft = buildBlueskyDraft({ title: 'T', description: '', url: articleUrl('s') });
		const shared = await postToBluesky({ handle: 'freedomtimes.news', appPassword: 'test-app-pass' }, draft, { fetch: bsky.fetch, now: () => new Date('2026-10-31T22:00:00Z') });
		assert.deepEqual(shared, { id: 'at://did:plc:abc123/app.bsky.feed.post/3kxyz', url: 'https://bsky.app/profile/did:plc:abc123/post/3kxyz' });
		assert.deepEqual(bsky.calls.map((c) => c.url), [
			'https://bsky.social/xrpc/com.atproto.server.createSession',
			'https://bsky.social/xrpc/com.atproto.repo.createRecord',
		]);
		assert.deepEqual(JSON.parse(String(bsky.calls[0].init?.body)), { identifier: 'freedomtimes.news', password: 'test-app-pass' });
		const create = bsky.calls[1];
		assert.equal((create.init?.headers as Record<string, string>).authorization, 'Bearer jwt-1');
		const body = JSON.parse(String(create.init?.body));
		assert.equal(body.repo, 'did:plc:abc123');
		assert.equal(body.collection, 'app.bsky.feed.post');
		assert.equal(body.record.text, draft.text);
		assert.equal(blueskyWebUrl('not-a-uri'), null);
	});

	it('says whether a failure definitely did not post', async () => {
		const draft = buildBlueskyDraft({ title: 'T', description: '', url: articleUrl('s') });
		const run = (over: Parameters<typeof mockBluesky>[0]) =>
			postToBluesky({ handle: 'h', appPassword: 'p' }, draft, { fetch: mockBluesky(over).fetch, now: () => new Date() }).then(
				() => assert.fail('expected failure'),
				(e: unknown) => {
					assert.ok(e instanceof ShareNetworkError);
					assert.ok(!e.message.includes('test-app-pass') && !e.message.includes(' p)'));
					return e.definitelyNotPosted;
				},
			);
		assert.equal(await run({ session: () => json(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' }) }), true);
		assert.equal(await run({ create: () => json(400, { error: 'InvalidRequest' }) }), true);
		assert.equal(await run({ create: () => json(502, {}) }), false);
		assert.equal(await run({ create: () => Promise.reject(new Error('socket hang up')) }), false);
		assert.equal(await run({ create: () => json(200, {}) }), false);
	});
});

describe('admin-only access', () => {
	it('rejects anonymous callers (401) and non-admins (403)', async () => {
		const { deps, bsky } = harness();
		await assert.rejects(load(deps, { user: undefined }), (e: unknown) => e instanceof ShareAccessError && e.status === 401);
		for (const role of [10, 20, 30, 40]) {
			await assert.rejects(load(deps, { user: { ...ADMIN, role } }), (e: unknown) => e instanceof ShareAccessError && e.status === 403);
			await assert.rejects(
				handleSharePanel({ input: { type: 'block_action', action_id: 'bluesky_post', value: 'x' }, ui: PANEL_UI, user: { ...ADMIN, role }, requestUrl: PROD_URL }, deps),
				(e: unknown) => e instanceof ShareAccessError && e.status === 403,
			);
		}
		assert.equal(bsky.calls.length, 0);
	});

	it('rejects direct route calls without the host-attested editor panel context', async () => {
		const { deps } = harness();
		for (const ui of [undefined, null, { surface: 'admin-page' }, { surface: 'content-editor-action', entry: PANEL_UI.entry }, { surface: 'content-editor-panel' }]) {
			await assert.rejects(load(deps, { ui }), (e: unknown) => e instanceof ShareAccessError && e.status === 403);
		}
		assert.throws(
			() => assertSharePanelAccess({ user: ADMIN, ui: { ...PANEL_UI, entry: { ...PANEL_UI.entry, collection: 'pages' } } }),
			(e: unknown) => e instanceof ShareAccessError && e.status === 400,
		);
	});

	it('plugin route stays private with the default Admin permission, inside the admin editor only', () => {
		const src = readFileSync(new URL('../src/plugins/social-share.ts', import.meta.url), 'utf8');
		assert.match(src, /'editor\/bluesky': sharePanelRoute\(blueskyProvider\),/);
		assert.match(src, /'editor\/x': sharePanelRoute\(xProvider\),/);
		assert.doesNotMatch(src, /public\s*:\s*true/);
		assert.doesNotMatch(src, /permission\s*:/, 'no permission override: EmDash defaults to plugins:manage (Admin)');
		const panels = /editorPanels: \[([\s\S]*?)\],\s*\},/.exec(src)?.[1] ?? '';
		assert.deepEqual(
			panels.split('\n').map((l) => l.trim()).filter(Boolean),
			[
				"{ id: 'bluesky', title: 'Post to Bluesky', route: 'editor/bluesky', collections: ['posts'] },",
				"{ id: 'x', title: 'Post to X', route: 'editor/x', collections: ['posts'] },",
			],
		);
		assert.doesNotMatch(src, /\b(pages|widgets|entry)\s*:/, 'no admin pages, widgets or React entry');
		assert.doesNotMatch(src, /hooks\s*:/, 'nothing posts automatically');
		const config = readFileSync(new URL('../astro.config.ts', import.meta.url), 'utf8');
		assert.match(config, /id: 'ft-social-share'[\s\S]*?entrypoint: socialSharePluginPath/);
	});

	it('astro.config descriptor grants exactly the capabilities and hosts the plugin declares', () => {
		const src = readFileSync(new URL('../src/plugins/social-share.ts', import.meta.url), 'utf8');
		assert.match(src, /capabilities: \[\.\.\.SOCIAL_SHARE_CAPABILITIES\]/);
		assert.match(src, /allowedHosts: \[\.\.\.SOCIAL_SHARE_ALLOWED_HOSTS\]/);
		const config = readFileSync(new URL('../astro.config.ts', import.meta.url), 'utf8');
		const descriptor = /id: 'ft-social-share',[\s\S]*?allowedHosts: \[[^\]]*\]/.exec(config)?.[0] ?? '';
		const list = (name: string) =>
			[...(new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(descriptor)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
		assert.deepEqual(list('capabilities'), [...SOCIAL_SHARE_CAPABILITIES]);
		assert.deepEqual(list('allowedHosts'), [...SOCIAL_SHARE_ALLOWED_HOSTS]);
	});

	it('no public page, layout, component, script or static file renders the button or the route', () => {
		const root = fileURLToPath(new URL('..', import.meta.url));
		const allowed = new Set(['src/plugins/social-share.ts']);
		const needles = [
			'ft-social-share',
			'editor/bluesky',
			'editor/x',
			'Post to Bluesky',
			'Post to X',
			'social-share',
			'BLUESKY_APP_PASSWORD',
			'X_API_KEY_SECRET',
			'X_ACCESS_TOKEN_SECRET',
			'api.x.com/2/tweets',
		];
		const hits: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				const rel = relative(root, full).replace(/\\/g, '/');
				if (statSync(full).isDirectory()) {
					if (rel === 'src/lib/social-share' || rel === 'src/lib/x-auto') continue;
					walk(full);
				} else if (/\.(astro|ts|tsx|js|mjs|jsx|html|json|webmanifest|css)$/.test(name) && !allowed.has(rel)) {
					const text = readFileSync(full, 'utf8');
					for (const n of needles) if (text.includes(n)) hits.push(`${rel}: ${n}`);
				}
			}
		};
		walk(join(root, 'src'));
		walk(join(root, 'public'));
		assert.deepEqual(hits, []);
	});

	it('an external editor link opens in a new tab', () => {
		const blocks = readFileSync(new URL('../node_modules/@emdash-cms/blocks/dist/index.js', import.meta.url), 'utf8');
		assert.match(blocks, /target: external \? "_blank"/);
	});

	it('the plugin route is never stored in the anonymous page cache', () => {
		assert.equal(isCacheablePath('/_emdash/api/plugins/ft-social-share/editor/bluesky'), false);
		assert.equal(isCacheablePath('/_emdash/api/plugins/ft-social-share/editor/x'), false);
	});
});

describe('Post to Bluesky panel', () => {
	it('staging without test secrets, and every other host, is a dry run that sends and records nothing (#178)', async () => {
		const { deps, kv, bsky } = harness();
		const LOCAL = 'http://localhost:4321/_emdash/x';
		const TEST_SECRETS = { BLUESKY_TEST_HANDLE: 'ft-test.bsky.social', BLUESKY_TEST_APP_PASSWORD: 'test-pass' };
		for (const [url, env, title] of [
			// Production secret names on the staging Worker are ignored: staging reads only *_TEST_* names.
			[STAGING_URL, { ...PROD_ENV, SITE_ACCESS_MODE: 'locked' }, 'Staging: dry run'],
			[STAGING_URL, PROD_ENV, 'Local: dry run'],
			[PROD_URL, { ...PROD_ENV, SITE_ACCESS_MODE: 'locked' }, 'Local: dry run'],
			[LOCAL, PROD_ENV, 'Local: dry run'],
			// Local dev never posts, even with test secrets in .dev.vars.
			[LOCAL, { SITE_ACCESS_MODE: 'locked', ...TEST_SECRETS }, 'Local: dry run'],
		] as const) {
			const res = await load({ ...deps, env }, { url });
			assert.equal(res.blocks[0].type, 'banner');
			assert.equal(res.blocks[0].title, title, url);
			assert.equal(res.blocks.find((b) => b.type === 'code')?.code, 'Cult news this week\n\nhttps://freedomtimes.news/posts/cult-news-weekly');
			const request = JSON.parse(String(res.blocks.filter((b) => b.type === 'code')[1]?.code));
			assert.equal(request.collection, 'app.bsky.feed.post');
			assert.equal(request.record.embed.$type, 'app.bsky.embed.external');
			assert.equal(request.record.embed.external.uri, 'https://freedomtimes.news/posts/cult-news-weekly');
			assert.doesNotMatch(JSON.stringify(res), /test-app-pass|test-pass/, 'no credential in the panel');
			const button = findButton(res.blocks, 'bluesky_post');
			assert.equal(button?.label, 'Dry run: Post to Bluesky');
			const link = findExternalLink(res.blocks);
			assert.equal((link?.target as { kind?: string })?.kind, 'external');
			assert.match(String((link?.target as { url?: string })?.url), /^https:\/\/bsky\.app\/intent\/compose\?text=/);
			assert.equal(button?.confirm, undefined, 'a dry run needs no confirm: it sends nothing');
			const clicked = await act({ ...deps, env }, 'bluesky_post', button?.value, url);
			assert.equal(clicked.toast?.type, 'info');
			assert.match(String(clicked.toast?.message), /^Dry run: .*Nothing was sent and nothing was recorded\.$/);
			assert.equal(clicked.blocks[0].title, title);
			const stale = await act({ ...deps, env }, 'bluesky_post', 'anything', url);
			assert.equal(stale.toast?.type, 'error');
		}
		assert.equal(bsky.calls.length, 0);
		assert.equal(kv.data.size, 0, 'a dry run records nothing');
	});

	it('explains missing secrets instead of failing', async () => {
		const { deps, bsky } = harness({ env: { SITE_ACCESS_MODE: 'public' } });
		const res = await load(deps);
		assert.equal(res.blocks[0].title, "Bluesky sharing isn't configured");
		assert.match(String(res.blocks[0].description), /BLUESKY_HANDLE and BLUESKY_APP_PASSWORD/);
		assert.equal(findButton(res.blocks, 'bluesky_post'), undefined);
		const link = findExternalLink(res.blocks);
		assert.equal(link?.label, 'Open Bluesky to post');
		assert.equal((link?.target as { kind?: string })?.kind, 'external');
		assert.match(String((link?.target as { url?: string })?.url), /^https:\/\/bsky\.app\/intent\/compose\?text=/);
		assert.equal(bsky.calls.length, 0);
	});

	it('asks to publish drafts first', async () => {
		for (const post of [{ ...POST, status: 'draft' }, { ...POST, status: 'scheduled' }, { ...POST, slug: null }]) {
			const { deps } = harness({ post });
			const res = await load(deps);
			assert.match(String(res.blocks[0].text), /Publish this post first/);
			assert.equal(findButton(res.blocks, 'bluesky_post'), undefined);
		}
	});

	it('shows the exact text and link, posts nothing on load, and confirms before posting', async () => {
		const { deps, bsky } = harness();
		const res = await load(deps);
		const code = res.blocks.find((b) => b.type === 'code');
		assert.equal(code?.code, 'Cult news this week\n\nhttps://freedomtimes.news/posts/cult-news-weekly');
		assert.equal('language' in (code ?? {}), false, 'plain text, no syntax highlighting');
		const fields = (res.blocks.find((b) => b.type === 'fields')?.fields ?? []) as Array<{ label: string; value: string }>;
		assert.deepEqual(fields.map((f) => f.label), ['Link card title', 'Link card description']);
		const button = findButton(res.blocks, 'bluesky_post');
		assert.ok(button);
		const confirm = button.confirm as { title: string; text: string };
		assert.equal(confirm.title, 'Post to Bluesky as @freedomtimes.news?');
		assert.ok(confirm.text.includes(String(code?.code)));
		assert.equal(bsky.calls.length, 0);
	});

	it('posts once on confirm, records the share, and refuses a second post', async () => {
		const { deps, kv, bsky } = harness();
		const button = findButton((await load(deps)).blocks, 'bluesky_post');
		const res = await act(deps, 'bluesky_post', button?.value);
		assert.equal(res.toast?.type, 'success');
		assert.equal(bsky.creates(), 1);
		const record = (await kv.getVersioned<Record<string, unknown>>('share:bluesky:p1'))?.value;
		assert.equal(record?.status, 'posted');
		assert.equal(record?.remoteUrl, 'https://bsky.app/profile/did:plc:abc123/post/3kxyz');
		assert.equal(record?.claimedBy, 'Ada Admin');
		assert.equal(res.blocks[0].title, 'Shared to Bluesky');
		assert.equal(findButton(res.blocks, 'bluesky_post'), undefined);

		const again = await act(deps, 'bluesky_post', button?.value);
		assert.equal(again.toast?.type, 'error');
		assert.equal(bsky.creates(), 1);
	});

	it('two simultaneous confirms post only once', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const bsky = mockBluesky({ create: async () => (await gate, json(200, { uri: 'at://did:plc:abc123/app.bsky.feed.post/3kxyz' })) });
		const { deps } = harness({ fetch: bsky.fetch });
		const value = findButton((await load(deps)).blocks, 'bluesky_post')?.value;
		const first = act(deps, 'bluesky_post', value);
		await new Promise((r) => setTimeout(r, 10));
		const second = await act(deps, 'bluesky_post', value);
		release();
		await first;
		assert.equal(bsky.creates(), 1);
		assert.notEqual(second.toast?.type, 'success');
	});

	it('refuses a stale confirm when the post text changed', async () => {
		const { deps, bsky } = harness();
		const res = await act(deps, 'bluesky_post', 'stale-fingerprint');
		assert.match(String(res.toast?.message), /changed since the preview/);
		assert.equal(bsky.calls.length, 0);
	});

	it('releases the lock when Bluesky rejects the sign-in', async () => {
		const bsky = mockBluesky({ session: () => json(401, { error: 'AuthenticationRequired' }) });
		const { deps, kv } = harness({ fetch: bsky.fetch });
		const value = findButton((await load(deps)).blocks, 'bluesky_post')?.value;
		const res = await act(deps, 'bluesky_post', value);
		assert.equal(res.toast?.type, 'error');
		assert.match(String(res.toast?.message), /^Not posted: Bluesky sign-in failed/);
		assert.equal(kv.data.size, 0);
		assert.ok(findButton(res.blocks, 'bluesky_post'));
	});

	it('keeps the lock when the outcome is unknown, until an admin releases it', async () => {
		const bsky = mockBluesky({ create: () => json(502, {}) });
		const { deps, kv } = harness({ fetch: bsky.fetch });
		const value = findButton((await load(deps)).blocks, 'bluesky_post')?.value;
		const res = await act(deps, 'bluesky_post', value);
		assert.equal((await kv.getVersioned<{ status: string }>('share:bluesky:p1'))?.value.status, 'uncertain');
		assert.equal(findButton(res.blocks, 'bluesky_post'), undefined);
		assert.ok(findButton(res.blocks, 'bluesky_release'));
		assert.equal((await act(deps, 'bluesky_post', value)).toast?.type, 'error');
		assert.equal(bsky.creates(), 1);

		const released = await act(deps, 'bluesky_release');
		assert.equal(kv.data.size, 0);
		assert.ok(findButton(released.blocks, 'bluesky_post'));
	});

	it('only offers release for interrupted (stale) pending claims', async () => {
		let now = new Date('2026-10-31T22:45:00Z');
		const { deps, kv } = harness({ now: () => now });
		await kv.set('share:bluesky:p1', { network: 'bluesky', postId: 'p1', status: 'pending', text: 't', claimedAt: now.toISOString(), claimedBy: 'Ada Admin' });
		const fresh = await load(deps);
		assert.equal(fresh.blocks[0].title, 'Posting in progress');
		await act(deps, 'bluesky_release');
		assert.equal(kv.data.size, 1, 'fresh claims cannot be released');
		now = new Date(now.getTime() + STALE_PENDING_MS + 1000);
		assert.ok(findButton((await load(deps)).blocks, 'bluesky_release'));
		await act(deps, 'bluesky_release');
		assert.equal(kv.data.size, 0);
	});
});

const X_ENV = {
	SITE_ACCESS_MODE: 'public',
	X_API_KEY: 'test-consumer-key',
	X_API_KEY_SECRET: 'test-consumer-secret',
	X_ACCESS_TOKEN: '1234567890-test-access-token',
	X_ACCESS_TOKEN_SECRET: 'test-token-secret',
};
const X_CONFIG = readXConfig(X_ENV)!;

/** Mock X: POST /2/tweets only. */
function mockX(create?: () => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
		calls.push({ url, init });
		if (url === 'https://api.x.com/2/tweets') {
			return create ? create() : json(201, { data: { id: '1851234567890123456', text: 'echo' } });
		}
		throw new Error(`unexpected fetch ${url}`);
	};
	return { calls, fetch };
}

function parseOAuthHeader(header: string): Record<string, string> {
	assert.match(header, /^OAuth /);
	return Object.fromEntries(
		header
			.slice(6)
			.split(', ')
			.map((pair) => {
				const m = /^([^=]+)="([^"]*)"$/.exec(pair);
				assert.ok(m, pair);
				return [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
			}),
	);
}

describe('X client (mocked)', () => {
	it('needs all four secrets and names the account from the access token', () => {
		assert.equal(readXConfig({}), null);
		assert.equal(readXConfig({ ...X_ENV, X_ACCESS_TOKEN_SECRET: ' ' }), null);
		assert.deepEqual(X_CONFIG, {
			apiKey: 'test-consumer-key',
			apiKeySecret: 'test-consumer-secret',
			accessToken: '1234567890-test-access-token',
			accessTokenSecret: 'test-token-secret',
		});
		assert.equal(xAccountLabel(X_CONFIG), 'the X account with user id 1234567890');
		assert.equal(xAccountLabel({ ...X_CONFIG, accessToken: 'opaque' }), 'the X account that owns the access token');
	});

	it('signs exactly like the worked example in X\'s OAuth 1.0a guide', async () => {
		// docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature (sample keys, invalid for real use).
		const signature = await oauth1Signature({
			method: 'POST',
			url: 'https://api.x.com/1.1/statuses/update.json',
			params: {
				status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
				include_entities: 'true',
				oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
				oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
				oauth_signature_method: 'HMAC-SHA1',
				oauth_timestamp: '1318622958',
				oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
				oauth_version: '1.0',
			},
			consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
			tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
		});
		assert.equal(signature, 'Ls93hJiZbQ3akF3HF3x1Bz8/zU4=');
		assert.equal(oauthPercentEncode("a b!*'()~"), 'a%20b%21%2A%27%28%29~');
	});

	it('counts like X: 280 weighted, emoji and CJK count 2, the link counts 23', () => {
		assert.equal(xTextWeight('abc é “q”'), 9);
		assert.equal(xTextWeight('🚨'), 2);
		assert.equal(xTextWeight('👩‍👩‍👧'), 2);
		assert.equal(xTextWeight('日本'), 4);
		assert.equal(truncateXWeighted('abcdef', 5), 'abc…');
		const url = articleUrl(`a-${'very-'.repeat(40)}long-slug`);
		const draft = buildXDraft({ title: '“Quoted” 🚨 日本 '.repeat(40), description: 'ignored', url });
		assert.ok(draft.weightedLength <= X_MAX_WEIGHTED_LENGTH);
		assert.ok(draft.weightedLength > X_MAX_WEIGHTED_LENGTH - 4, 'uses the room');
		assert.ok(draft.text.endsWith(`\n\n${url}`), 'the full link is always kept');
		assert.ok(draft.text.includes('…'));
		assert.equal(xWeightedLength(`Cult news\n\n${url}`), 9 + 2 + 23);
		assert.equal(xWeightedLength('Read freedomtimes.news or bit.ly/x today'), 5 + 23 + 4 + 23 + 6);
		assert.equal(xWeightedLength('e.g. U.S. news'), 14, 'abbreviations are not links');
		const linky = buildXDraft({ title: `${'word '.repeat(40)}see freedomtimes.news ${'more '.repeat(10)}`, description: '', url });
		assert.ok(linky.weightedLength <= X_MAX_WEIGHTED_LENGTH, 'a domain in the title is counted as 23, never under-counted');
		assert.equal(linky.weightedLength, xWeightedLength(linky.text));
		const short = buildXDraft({ title: 'Cult news', description: '', url });
		assert.equal(short.text, `Cult news\n\n${url}`);
		assert.equal(short.weightedLength, 9 + 2 + 23);
	});

	it('makes one signed POST /2/tweets with only the text, and returns the post URL', async () => {
		const x = mockX();
		const draft = buildXDraft({ title: 'T', description: '', url: articleUrl('s') });
		const now = new Date('2026-10-31T22:00:00Z');
		const shared = await postToX(X_CONFIG, draft, { fetch: x.fetch, now: () => now });
		assert.deepEqual(shared, { id: '1851234567890123456', url: 'https://x.com/i/web/status/1851234567890123456' });
		assert.equal(x.calls.length, 1);
		const { init } = x.calls[0];
		assert.equal(init?.method, 'POST');
		assert.deepEqual(JSON.parse(String(init?.body)), { text: draft.text });
		const headers = init?.headers as Record<string, string>;
		assert.equal(headers['content-type'], 'application/json');
		const oauth = parseOAuthHeader(headers.authorization);
		assert.equal(oauth.oauth_consumer_key, 'test-consumer-key');
		assert.equal(oauth.oauth_token, '1234567890-test-access-token');
		assert.equal(oauth.oauth_signature_method, 'HMAC-SHA1');
		assert.equal(oauth.oauth_timestamp, String(now.getTime() / 1000));
		assert.equal(oauth.oauth_version, '1.0');
		assert.match(oauth.oauth_nonce, /^[0-9a-f]{32}$/);
		const expected = await oauth1Header({ method: 'POST', url: 'https://api.x.com/2/tweets', config: X_CONFIG, nonce: oauth.oauth_nonce, timestamp: now.getTime() / 1000 });
		assert.equal(headers.authorization, expected, 'signature covers the oauth_* params only (JSON body is not signed)');
		assert.ok(!headers.authorization.includes('test-consumer-secret') && !headers.authorization.includes('test-token-secret'));
	});

	it('says whether a failure definitely did not post', async () => {
		const draft = buildXDraft({ title: 'T', description: '', url: articleUrl('s') });
		const run = (create: () => Response | Promise<Response>) =>
			postToX(X_CONFIG, draft, { fetch: mockX(create).fetch, now: () => new Date() }).then(
				() => assert.fail('expected failure'),
				(e: unknown) => {
					assert.ok(e instanceof ShareNetworkError);
					assert.ok(!e.message.includes('test-consumer-secret') && !e.message.includes('test-token-secret'));
					return e.definitelyNotPosted;
				},
			);
		assert.equal(await run(() => json(401, { title: 'Unauthorized', detail: 'Unauthorized', status: 401 })), true);
		assert.equal(await run(() => json(403, { detail: 'You are not permitted to perform this action.' })), true);
		assert.equal(await run(() => json(400, { title: 'Invalid Request' })), true);
		assert.equal(await run(() => json(429, { title: 'Too Many Requests' })), true);
		assert.equal(await run(() => json(503, {})), false);
		assert.equal(await run(() => Promise.reject(new Error('socket hang up'))), false);
		assert.equal(await run(() => json(201, { errors: [{ message: 'odd' }] })), false);
	});
});

describe('Post to X panel', () => {
	const X_URL = 'https://freedomtimes.news/_emdash/api/content/posts/p1/extensions/panel/ft-social-share/x';
	const xHarness = (create?: () => Response | Promise<Response>, env: Record<string, unknown> = X_ENV) => {
		const x = mockX(create);
		const { deps, kv } = harness({ provider: xProvider as never, env, fetch: x.fetch });
		return { deps, kv, x };
	};
	const xLoad = (deps: SharePanelDeps<never, never>, url = X_URL) => load(deps, { url, ui: { ...PANEL_UI, extensionId: 'x' } });
	const xAct = (deps: SharePanelDeps<never, never>, action_id: string, value?: unknown, url = X_URL) =>
		handleSharePanel({ input: { type: 'block_action', action_id, value }, ui: { ...PANEL_UI, extensionId: 'x' }, user: ADMIN, requestUrl: url }, deps);

	it('is admin-only, production-only and explains missing secrets', async () => {
		const { deps, x } = xHarness();
		await assert.rejects(load(deps, { user: undefined, url: X_URL }), (e: unknown) => e instanceof ShareAccessError && e.status === 401);
		await assert.rejects(load(deps, { user: { ...ADMIN, role: 40 }, url: X_URL }), (e: unknown) => e instanceof ShareAccessError && e.status === 403);
		const staging = await xLoad({ ...deps, env: { ...X_ENV, SITE_ACCESS_MODE: 'locked' } }, STAGING_URL.replace(/bluesky$/, 'x'));
		assert.equal(staging.blocks[0].title, 'Staging: dry run', 'production X names on staging are ignored');
		assert.equal(findButton(staging.blocks, 'x_post')?.label, 'Dry run: Post to X');
		assert.match(String((findExternalLink(staging.blocks)?.target as { url?: string })?.url), /^https:\/\/x\.com\/intent\/post\?text=/);
		const missing = await xLoad({ ...deps, env: { SITE_ACCESS_MODE: 'public', X_API_KEY: 'k' } });
		assert.equal(missing.blocks[0].title, "X sharing isn't configured");
		assert.match(String(missing.blocks[0].description), /X_API_KEY, X_API_KEY_SECRET, X_ACCESS_TOKEN, and X_ACCESS_TOKEN_SECRET/);
		assert.equal(findButton(missing.blocks, 'x_post'), undefined);
		assert.equal(findExternalLink(missing.blocks)?.label, 'Open X to post');
		assert.equal(x.calls.length, 0);
	});

	it('previews the exact text, posts once on confirm and records it separately from Bluesky', async () => {
		const { deps, kv, x } = xHarness();
		await kv.set('share:bluesky:p1', { status: 'posted' });
		const res = await xLoad(deps);
		assert.equal(res.blocks.find((b) => b.type === 'code')?.code, 'Cult news this week\n\nhttps://freedomtimes.news/posts/cult-news-weekly');
		const fields = (res.blocks.find((b) => b.type === 'fields')?.fields ?? []) as Array<{ label: string; value: string }>;
		assert.equal(fields[0].value, `${xTextWeight('Cult news this week') + 2 + 23} / 280`);
		const button = findButton(res.blocks, 'x_post');
		assert.ok(button, 'a Bluesky share does not block X');
		assert.equal((button.confirm as { title: string }).title, 'Post to X as the X account with user id 1234567890?');
		assert.equal(x.calls.length, 0, 'nothing posts on load');

		const posted = await xAct(deps, 'x_post', button.value);
		assert.equal(posted.toast?.type, 'success');
		assert.equal(posted.blocks[0].title, 'Shared to X');
		const record = (await kv.getVersioned<Record<string, unknown>>('share:x:p1'))?.value;
		assert.equal(record?.status, 'posted');
		assert.equal(record?.remoteUrl, 'https://x.com/i/web/status/1851234567890123456');

		const again = await xAct(deps, 'x_post', button.value);
		assert.equal(again.toast?.type, 'error');
		assert.equal(x.calls.length, 1);
		assert.equal(findButton(again.blocks, 'bluesky_post'), undefined);
	});

	it('releases the lock on a 4xx and keeps it when the outcome is unknown', async () => {
		const refused = xHarness(() => json(403, { detail: 'read-only app' }));
		const value = findButton((await xLoad(refused.deps)).blocks, 'x_post')?.value;
		const res = await xAct(refused.deps, 'x_post', value);
		assert.match(String(res.toast?.message), /^Not posted: X refused the post \(HTTP 403: read-only app\)/);
		assert.equal(refused.kv.data.size, 0);

		const unknown = xHarness(() => json(503, {}));
		const value2 = findButton((await xLoad(unknown.deps)).blocks, 'x_post')?.value;
		await xAct(unknown.deps, 'x_post', value2);
		assert.equal((await unknown.kv.getVersioned<Record<string, unknown>>('share:x:p1'))?.value.status, 'uncertain');
		const after = await xLoad(unknown.deps);
		assert.equal(findButton(after.blocks, 'x_post'), undefined);
		assert.ok(findButton(after.blocks, 'x_release'));
	});
});

describe('staging test accounts and dry run (#178)', () => {
	const STAGING_X_URL = STAGING_URL.replace(/bluesky$/, 'x');
	const BSKY_TEST = { SITE_ACCESS_MODE: 'locked', BLUESKY_TEST_HANDLE: '@ft-test.bsky.social', BLUESKY_TEST_APP_PASSWORD: 'test-only-pass' };
	const X_TEST = {
		SITE_ACCESS_MODE: 'locked',
		X_TEST_API_KEY: 'stg-consumer-key',
		X_TEST_API_KEY_SECRET: 'stg-consumer-secret',
		X_TEST_ACCESS_TOKEN: '999000111-stg-access-token',
		X_TEST_ACCESS_TOKEN_SECRET: 'stg-token-secret',
	};

	/** Env that records every key the code reads. */
	function trackedEnv(env: Record<string, unknown>) {
		const read = new Set<string>();
		const proxy = new Proxy(env, {
			get(target, key) {
				if (typeof key === 'string') read.add(key);
				return Reflect.get(target, key);
			},
		});
		return { proxy, read };
	}

	it('picks the mode from the Worker access mode and the host', () => {
		assert.equal(socialShareMode({ siteAccessMode: 'public', hostname: 'freedomtimes.news' }), 'production');
		assert.equal(socialShareMode({ siteAccessMode: 'public', hostname: 'www.freedomtimes.news' }), 'production');
		assert.equal(socialShareMode({ siteAccessMode: 'locked', hostname: 'staging.freedomtimes.news' }), 'staging');
		assert.equal(socialShareMode({ siteAccessMode: 'LOCKED ', hostname: 'Staging.FreedomTimes.news' }), 'staging');
		for (const [siteAccessMode, hostname] of [
			['public', 'staging.freedomtimes.news'],
			['locked', 'freedomtimes.news'],
			['locked', 'localhost'],
			[undefined, 'staging.freedomtimes.news'],
			['locked', 'freedomtimes-staging.example.workers.dev'],
		] as const) {
			assert.equal(socialShareMode({ siteAccessMode, hostname }), 'local', `${siteAccessMode} ${hostname}`);
		}
	});

	it('staging uses only distinct *_TEST_* secret names; production never reads them; local reads none', () => {
		for (const [provider, prod, test] of [
			[blueskyProvider, BLUESKY_SECRET_NAMES, BLUESKY_TEST_SECRET_NAMES],
			[xProvider, X_SECRET_NAMES, X_TEST_SECRET_NAMES],
		] as const) {
			assert.deepEqual(shareSecretNames(provider as never, 'production'), prod);
			assert.deepEqual(shareSecretNames(provider as never, 'staging'), test);
			assert.deepEqual(shareSecretNames(provider as never, 'local'), []);
			assert.equal(test.length, prod.length);
			for (const name of test) {
				assert.match(name, /^(BLUESKY|X)_TEST_/);
				assert.ok(!(prod as readonly string[]).includes(name));
			}
			const both = { ...PROD_ENV, ...X_ENV, ...BSKY_TEST, ...X_TEST };
			for (const mode of ['production', 'staging', 'local'] as const) {
				const { proxy, read } = trackedEnv(both);
				readShareConfig(provider as never, proxy, mode);
				const allowed = mode === 'production' ? prod : mode === 'staging' ? test : [];
				assert.deepEqual([...read].sort(), [...allowed].sort(), `${provider.network} ${mode}`);
			}
		}
	});

	it('staging with test secrets posts to the Bluesky test account only, recorded apart from production', async () => {
		const { deps, kv, bsky } = harness({ env: { ...PROD_ENV, ...BSKY_TEST } });
		// A production record copied into the staging DB must not block a test post.
		await kv.set('share:bluesky:p1', { status: 'posted', postedAt: '2026-10-01T00:00:00Z', claimedBy: 'prod' });
		const { proxy, read } = trackedEnv(deps.env);
		const env = proxy as Record<string, unknown>;
		const res = await load({ ...deps, env }, { url: STAGING_URL });
		assert.equal(res.blocks[0].title, 'Staging: posting to test account @ft-test.bsky.social');
		assert.match(String(res.blocks[0].description), /BLUESKY_TEST_HANDLE and BLUESKY_TEST_APP_PASSWORD/);
		const button = findButton(res.blocks, 'bluesky_post');
		assert.equal(button?.label, 'Post to Bluesky test account');
		assert.equal((button?.confirm as { title: string }).title, 'Post to Bluesky as the test account @ft-test.bsky.social?');
		assert.equal(bsky.calls.length, 0, 'nothing posts on load');

		const posted = await act({ ...deps, env }, 'bluesky_post', button?.value, STAGING_URL);
		assert.equal(posted.toast?.message, 'Posted to the Bluesky test account.');
		assert.equal(posted.blocks[0].title, 'Staging: posting to test account @ft-test.bsky.social');
		assert.equal(posted.blocks[1].title, 'Shared to the Bluesky test account');
		const session = JSON.parse(String(bsky.calls[0].init?.body));
		assert.deepEqual(session, { identifier: 'ft-test.bsky.social', password: 'test-only-pass' });
		assert.equal(bsky.creates(), 1);
		assert.equal(shareRecordKey('bluesky', 'p1', 'staging'), 'share-test:bluesky:p1');
		assert.equal((await kv.getVersioned<Record<string, unknown>>('share-test:bluesky:p1'))?.value.status, 'posted');
		assert.equal((await kv.getVersioned<Record<string, unknown>>('share:bluesky:p1'))?.value.claimedBy, 'prod', 'production record untouched');
		for (const name of [...BLUESKY_SECRET_NAMES, ...X_SECRET_NAMES]) assert.ok(!read.has(name), `staging read ${name}`);
	});

	it('staging with test secrets posts to the X test account; a dry run never blocks a later real post', async () => {
		const x = mockX();
		const { deps, kv } = harness({ provider: xProvider as never, env: { ...X_ENV, SITE_ACCESS_MODE: 'locked' }, fetch: x.fetch });
		const ui = { ...PANEL_UI, extensionId: 'x' };
		const go = (env: Record<string, unknown>, input: Record<string, unknown>) =>
			handleSharePanel({ input, ui, user: ADMIN, requestUrl: STAGING_X_URL }, { ...deps, env } as never);

		const dry = await go({ ...X_ENV, SITE_ACCESS_MODE: 'locked' }, { type: 'panel_load' });
		assert.equal(dry.blocks[0].title, 'Staging: dry run');
		assert.deepEqual(JSON.parse(String(dry.blocks.filter((b) => b.type === 'code')[1]?.code)), {
			text: 'Cult news this week\n\nhttps://freedomtimes.news/posts/cult-news-weekly',
		});
		const dryClick = await go({ ...X_ENV, SITE_ACCESS_MODE: 'locked' }, { type: 'block_action', action_id: 'x_post', value: findButton(dry.blocks, 'x_post')?.value });
		assert.equal(dryClick.toast?.type, 'info');
		assert.equal(kv.data.size, 0);

		const ready = await go(X_TEST, { type: 'panel_load' });
		assert.equal(ready.blocks[0].title, 'Staging: posting to test account the X account with user id 999000111');
		const button = findButton(ready.blocks, 'x_post');
		assert.equal(button?.label, 'Post to X test account');
		const posted = await go(X_TEST, { type: 'block_action', action_id: 'x_post', value: button?.value });
		assert.equal(posted.toast?.message, 'Posted to the X test account.');
		assert.equal(x.calls.length, 1);
		const oauth = parseOAuthHeader(String((x.calls[0].init?.headers as Record<string, string>).authorization));
		assert.equal(oauth.oauth_consumer_key, 'stg-consumer-key');
		assert.equal(oauth.oauth_token, '999000111-stg-access-token');
		assert.equal((await kv.getVersioned<Record<string, unknown>>('share-test:x:p1'))?.value.status, 'posted');
		assert.equal(await kv.getVersioned('share:x:p1'), null);
	});

	it('production is unchanged: real names only, no mode banner, test names ignored', async () => {
		const testOnly = harness({ env: { ...BSKY_TEST, SITE_ACCESS_MODE: 'public' } });
		const missing = await load(testOnly.deps);
		assert.equal(missing.blocks[0].title, "Bluesky sharing isn't configured", 'production never falls back to test names');
		assert.equal(findButton(missing.blocks, 'bluesky_post'), undefined);

		const { deps, kv, bsky } = harness({ env: { ...BSKY_TEST, ...PROD_ENV } });
		const res = await load(deps);
		assert.equal(res.blocks[0].type, 'context');
		assert.equal(res.blocks[0].text, 'Preview. Nothing is posted until you press the button and confirm. Posts as @freedomtimes.news.');
		assert.ok(!res.blocks.some((b) => b.type === 'banner'));
		const button = findButton(res.blocks, 'bluesky_post');
		assert.equal(button?.label, 'Post to Bluesky');
		const posted = await act(deps, 'bluesky_post', button?.value);
		assert.equal(posted.toast?.message, 'Posted to Bluesky.');
		assert.equal(JSON.parse(String(bsky.calls[0].init?.body)).identifier, 'freedomtimes.news');
		assert.equal((await kv.getVersioned<Record<string, unknown>>('share:bluesky:p1'))?.value.status, 'posted');
		assert.equal(await kv.getVersioned('share-test:bluesky:p1'), null);
		assert.equal(shareRecordKey('x', 'p1'), 'share:x:p1');
	});

	it('the release lock on staging works on the test record', async () => {
		const { deps, kv } = harness({ env: BSKY_TEST });
		await kv.set('share-test:bluesky:p1', { network: 'bluesky', postId: 'p1', status: 'uncertain', text: 't', claimedAt: '2026-10-31T22:00:00Z', claimedBy: 'Ada' });
		const res = await load(deps, { url: STAGING_URL });
		assert.ok(findButton(res.blocks, 'bluesky_release'));
		assert.match(String(res.blocks[1].description), /Check the Bluesky test account's profile first/);
		const released = await act(deps, 'bluesky_release', undefined, STAGING_URL);
		assert.equal(released.toast?.message, 'Lock released. Check the preview before posting again.');
		assert.equal(kv.data.size, 0);
	});
});
