/**
 * Admin-only "Post to Bluesky" panel (#21): Bluesky client, panel states,
 * double-post lock and admin-only placement. Every network call is mocked;
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
	ShareAccessError,
	type ShareKv,
	type SharePanelDeps,
	STALE_PENDING_MS,
} from '../src/lib/social-share/panel.ts';
import {
	articleUrl,
	graphemeLength,
	isSocialShareEnvironment,
	ShareNetworkError,
	snapshotFromContentItem,
	type SharePostSnapshot,
	truncateGraphemes,
} from '../src/lib/social-share/policy.ts';

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
		assert.match(src, /'editor\/bluesky':\s*\{/);
		assert.doesNotMatch(src, /public\s*:\s*true/);
		assert.doesNotMatch(src, /permission\s*:/, 'no permission override: EmDash defaults to plugins:manage (Admin)');
		assert.match(src, /editorPanels:\s*\[\{ id: 'bluesky', title: 'Post to Bluesky', route: 'editor\/bluesky', collections: \['posts'\] \}\]/);
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
		const needles = ['ft-social-share', 'editor/bluesky', 'Post to Bluesky', 'social-share', 'BLUESKY_APP_PASSWORD'];
		const hits: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				const rel = relative(root, full).replace(/\\/g, '/');
				if (statSync(full).isDirectory()) {
					if (rel === 'src/lib/social-share') continue;
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

	it('the plugin route is never stored in the anonymous page cache', () => {
		assert.equal(isCacheablePath('/_emdash/api/plugins/ft-social-share/editor/bluesky'), false);
	});
});

describe('Post to Bluesky panel', () => {
	it('is disabled outside production, with no button and no network call', async () => {
		const { deps, bsky } = harness();
		for (const [url, env] of [
			[STAGING_URL, { ...PROD_ENV, SITE_ACCESS_MODE: 'locked' }],
			[STAGING_URL, PROD_ENV],
			[PROD_URL, { ...PROD_ENV, SITE_ACCESS_MODE: 'locked' }],
			['http://localhost:4321/_emdash/x', PROD_ENV],
		] as const) {
			const res = await load({ ...deps, env }, { url });
			assert.equal(res.blocks[0].type, 'banner');
			assert.equal(res.blocks[0].title, 'Disabled outside production');
			assert.equal(findButton(res.blocks, 'bluesky_post'), undefined);
			const clicked = await act({ ...deps, env }, 'bluesky_post', 'anything', url);
			assert.equal(clicked.toast?.type, 'error');
		}
		assert.equal(bsky.calls.length, 0);
	});

	it('explains missing secrets instead of failing', async () => {
		const { deps, bsky } = harness({ env: { SITE_ACCESS_MODE: 'public' } });
		const res = await load(deps);
		assert.equal(res.blocks[0].title, "Bluesky sharing isn't configured");
		assert.match(String(res.blocks[0].description), /BLUESKY_HANDLE and BLUESKY_APP_PASSWORD/);
		assert.equal(findButton(res.blocks, 'bluesky_post'), undefined);
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
