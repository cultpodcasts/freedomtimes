/**
 * Automatic X and Bluesky posts on publish. Nothing here reaches either
 * network. Nothing emails.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ShareKv } from '../src/lib/social-share/panel.ts';
import { X_AUTO_ALLOWED_HOSTS, X_AUTO_CAPABILITIES } from '../src/lib/x-auto/manifest.ts';
import { effectiveXAutoMode } from '../src/lib/x-auto/mode.ts';
import { handleXAutoPublish, X_AUTO_STALE_PENDING_MS, type XAutoDeps } from '../src/lib/x-auto/run.ts';

const ARTICLE = 'https://freedomtimes.news/posts/cult-news-weekly';
const PROD = {
	SITE_ACCESS_MODE: 'public',
	X_AUTO_POST_ALLOW_SEND: 'yes',
};
const SECRETS = {
	X_API_KEY: 'key',
	X_API_KEY_SECRET: 'key-secret',
	X_ACCESS_TOKEN: '1234567890-token',
	X_ACCESS_TOKEN_SECRET: 'token-secret',
	BLUESKY_HANDLE: 'freedomtimes.bsky.social',
	BLUESKY_APP_PASSWORD: 'app-pass',
};

class FakeKv implements ShareKv {
	data = new Map<string, { value: unknown; revision: string }>();
	private n = 0;
	async getVersioned<T>(key: string) {
		const hit = this.data.get(key);
		return hit ? { value: structuredClone(hit.value) as T, revision: hit.revision } : null;
	}
	async compareAndSet(key: string, expected: string | null, value: unknown) {
		const hit = this.data.get(key);
		const revision = hit?.revision ?? null;
		if (revision !== expected) return { applied: false as const };
		const next = String(++this.n);
		this.data.set(key, { value: structuredClone(value), revision: next });
		return { applied: true as const, revision: next };
	}
	async compareAndDelete(key: string, expected: string) {
		const hit = this.data.get(key);
		if (!hit || hit.revision !== expected) return { applied: false };
		this.data.delete(key);
		return { applied: true };
	}
	async set(key: string, value: unknown) {
		this.data.set(key, { value: structuredClone(value), revision: String(++this.n) });
	}
}

function post(overrides: Record<string, unknown> = {}) {
	return {
		id: 'post-1',
		slug: 'cult-news-weekly',
		status: 'published',
		data: { title: 'Cult news this week', lede: 'A short hook about the week.' },
		...overrides,
	};
}

function networkResponse(url: string, status = 200): Response {
	if (url.includes('createSession')) {
		return new Response(JSON.stringify({ accessJwt: 'jwt', did: 'did:plc:abc' }), { status });
	}
	if (url.includes('createRecord')) {
		return new Response(JSON.stringify({ uri: 'at://did:plc:abc/app.bsky.feed.post/xyz' }), { status });
	}
	return new Response(JSON.stringify({ data: { id: '1851234567890123456' } }), { status });
}

function harness(env: Record<string, unknown>) {
	const kv = new FakeKv();
	const calls: string[] = [];
	const logs: string[] = [];
	let now = new Date('2026-11-01T12:44:00.000Z');
	const deps: XAutoDeps = {
		env,
		kv,
		now: () => now,
		fetch: async (url) => {
			calls.push(url);
			return networkResponse(url);
		},
		log: (level, message) => logs.push(`${level}:${message}`),
	};
	return {
		deps,
		kv,
		calls,
		logs,
		setNow(date: Date) {
			now = date;
		},
	};
}

describe('production gate', () => {
	it('posts only when production mode and the allow flag are both set', () => {
		assert.equal(effectiveXAutoMode({ ...PROD, X_AUTO_POST_MODE: 'api' }), 'api');
		assert.equal(effectiveXAutoMode({ SITE_ACCESS_MODE: 'public', X_AUTO_POST_MODE: 'api' }), 'dry-run');
		assert.equal(
			effectiveXAutoMode({ SITE_ACCESS_MODE: 'locked', X_AUTO_POST_MODE: 'api', X_AUTO_POST_ALLOW_SEND: 'yes' }),
			'dry-run',
		);
		assert.equal(effectiveXAutoMode({ ...PROD, X_AUTO_POST_MODE: 'off' }), 'off');
		assert.equal(effectiveXAutoMode({ ...PROD, X_AUTO_POST_MODE: 'intent' }), 'dry-run');
		assert.equal(effectiveXAutoMode({}), 'dry-run');
	});
});

describe('publish hook', () => {
	it('dry-run logs both intent links and records nothing', async () => {
		const { deps, kv, calls, logs } = harness({
			...PROD,
			...SECRETS,
			SITE_ACCESS_MODE: 'locked',
			X_AUTO_POST_MODE: 'api',
		});
		const result = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(result.action, 'dry-run');
		assert.deepEqual(result.networks.map((n) => n.action), ['dry-run', 'dry-run']);
		assert.equal(result.networks[0]?.text, `Cult news this week\n\n${ARTICLE}`);
		assert.match(result.networks[0]?.intentUrl ?? '', /^https:\/\/x\.com\/intent\/post\?text=/);
		assert.match(result.networks[1]?.intentUrl ?? '', /^https:\/\/bsky\.app\/intent\/compose\?text=/);
		assert.match(logs[0] ?? '', /^info:dry-run x post-1 \(\d+ weighted\) https:\/\/x\.com\/intent\/post\?text=/);
		assert.match(logs[1] ?? '', /^info:dry-run bluesky post-1 \(\d+ chars\) https:\/\/bsky\.app\/intent\/compose\?text=/);
		assert.equal(calls.length, 0);
		assert.equal(kv.data.size, 0);
	});

	it('skips a network that has no secrets and still posts the other', async () => {
		const { deps, calls, logs } = harness({
			...PROD,
			X_AUTO_POST_MODE: 'api',
			BLUESKY_HANDLE: SECRETS.BLUESKY_HANDLE,
			BLUESKY_APP_PASSWORD: SECRETS.BLUESKY_APP_PASSWORD,
		});
		const result = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(result.action, 'api');
		assert.equal(result.networks[0]?.action, 'skipped');
		assert.equal(result.networks[0]?.reason, 'not-configured');
		assert.match(result.networks[0]?.intentUrl ?? '', /^https:\/\/x\.com\/intent\/post\?text=/);
		assert.equal(result.networks[1]?.action, 'posted');
		assert.equal(result.networks[1]?.remoteUrl, 'https://bsky.app/profile/did:plc:abc/post/xyz');
		assert.equal(calls.some((url) => url.includes('api.x.com')), false);
		assert.match(logs.join('\n'), /x post-1 not configured/);
	});

	it('posts both networks once, then ignores a republish', async () => {
		const { deps, kv, calls } = harness({ ...PROD, ...SECRETS, X_AUTO_POST_MODE: 'api' });
		const first = await handleXAutoPublish(post(), 'posts', deps);
		assert.deepEqual(first.networks.map((n) => n.action), ['posted', 'posted']);
		assert.equal((kv.data.get('share:x:post-1')?.value as { status: string }).status, 'posted');
		assert.equal((kv.data.get('share:bluesky:post-1')?.value as { status: string }).status, 'posted');
		const sent = calls.length;
		const again = await handleXAutoPublish(post(), 'posts', deps);
		assert.deepEqual(again.networks.map((n) => n.reason), ['already-posted', 'already-posted']);
		assert.equal(calls.length, sent);
	});

	it('a 4xx releases the claim and an unknown outcome keeps it', async () => {
		const refused = harness({ ...PROD, ...SECRETS, X_AUTO_POST_MODE: 'api' });
		refused.deps.fetch = async (url) => {
			if (url.includes('api.x.com')) return networkResponse(url, 403);
			return networkResponse(url);
		};
		const failed = await handleXAutoPublish(post(), 'posts', refused.deps);
		assert.equal(failed.networks[0]?.action, 'failed');
		assert.equal(refused.kv.data.has('share:x:post-1'), false);
		assert.equal((refused.kv.data.get('share:bluesky:post-1')?.value as { status: string }).status, 'posted');

		const lost = harness({ ...PROD, ...SECRETS, X_AUTO_POST_MODE: 'api' });
		lost.deps.fetch = async (url) => {
			if (url.includes('api.x.com')) throw new Error('socket hang up');
			return networkResponse(url);
		};
		const uncertain = await handleXAutoPublish(post(), 'posts', lost.deps);
		assert.equal(uncertain.networks[0]?.action, 'failed');
		assert.equal((lost.kv.data.get('share:x:post-1')?.value as { status: string }).status, 'uncertain');
		const blocked = await handleXAutoPublish(post(), 'posts', lost.deps);
		assert.equal(blocked.networks[0]?.reason, 'in-progress');

		lost.setNow(new Date(Date.parse('2026-11-01T12:44:00.000Z') + X_AUTO_STALE_PENDING_MS + 1000));
		lost.deps.fetch = async (url) => networkResponse(url);
		const retried = await handleXAutoPublish(post(), 'posts', lost.deps);
		assert.equal(retried.networks[0]?.action, 'posted');
	});

	it('does not post pages, drafts, or a switched-off Worker', async () => {
		const { deps, calls } = harness({ ...PROD, ...SECRETS, X_AUTO_POST_MODE: 'api' });
		assert.equal((await handleXAutoPublish(post(), 'pages', deps)).reason, 'not-a-post');
		assert.equal((await handleXAutoPublish(post({ status: 'draft' }), 'posts', deps)).reason, 'not-a-published-post');
		const off = harness({ ...PROD, ...SECRETS, X_AUTO_POST_MODE: 'off' });
		assert.equal((await handleXAutoPublish(post(), 'posts', off.deps)).reason, 'off');
		assert.equal(calls.length, 0);
	});
});

describe('plugin registration', () => {
	it('astro.config grants exactly the capabilities and hosts the plugin declares', () => {
		const src = readFileSync(new URL('../src/plugins/x-auto-post.ts', import.meta.url), 'utf8');
		assert.match(src, /capabilities: \[\.\.\.X_AUTO_CAPABILITIES\]/);
		assert.match(src, /allowedHosts: \[\.\.\.X_AUTO_ALLOWED_HOSTS\]/);
		assert.match(src, /content:afterPublish/);
		assert.doesNotMatch(src, /email:send|sendEmail/);
		assert.doesNotMatch(src, /public\s*:\s*true/);
		const config = readFileSync(new URL('../astro.config.ts', import.meta.url), 'utf8');
		const descriptor = /id: 'ft-x-auto-post',[\s\S]*?allowedHosts: \[[^\]]*\]/.exec(config)?.[0] ?? '';
		const list = (name: string) =>
			[...(new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(descriptor)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
		assert.deepEqual(list('capabilities'), [...X_AUTO_CAPABILITIES]);
		assert.deepEqual(list('allowedHosts'), [...X_AUTO_ALLOWED_HOSTS]);
	});

	it('neither environment posts on publish', () => {
		const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
		const production = /"production": \{[\s\S]*?\n\t\t\}/.exec(wrangler)?.[0] ?? '';
		const staging = /"staging": \{[\s\S]*$/.exec(wrangler)?.[0] ?? '';
		assert.match(production, /"X_AUTO_POST_MODE": "dry-run"/);
		assert.doesNotMatch(production, /X_AUTO_POST_ALLOW_SEND/);
		assert.doesNotMatch(production, /X_AUTO_POST_NOTIFY_TO/);
		assert.match(staging, /"X_AUTO_POST_MODE": "dry-run"/);
		assert.doesNotMatch(staging, /X_AUTO_POST_ALLOW_SEND/);
	});
});
