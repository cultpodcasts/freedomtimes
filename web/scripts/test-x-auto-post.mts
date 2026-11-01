/**
 * Automatic X post on publish: formatting, the 280-weighted limit, the
 * production-only gate, dedupe, and a mocked X API client. Nothing here
 * reaches X or sends email.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import type { ShareKv } from '../src/lib/social-share/panel.ts';
import { X_MAX_WEIGHTED_LENGTH, xWeightedLength } from '../src/lib/social-share/x.ts';
import { composeXPost, formatLondon, intentPostUrl } from '../src/lib/x-auto/compose.ts';
import { X_AUTO_ALLOWED_HOSTS, X_AUTO_CAPABILITIES } from '../src/lib/x-auto/manifest.ts';
import { effectiveXAutoMode } from '../src/lib/x-auto/mode.ts';
import { X_OAUTH2_TOKEN_URL } from '../src/lib/x-auto/oauth2.ts';
import { handleXAutoPublish, X_AUTO_STALE_PENDING_MS, type XAutoDeps, type XAutoEmail, type XAutoRecord } from '../src/lib/x-auto/run.ts';

const ARTICLE = 'https://freedomtimes.news/posts/cult-news-weekly';
const PROD = {
	SITE_ACCESS_MODE: 'public',
	X_AUTO_POST_ALLOW_SEND: 'yes',
	X_AUTO_POST_NOTIFY_TO: 'socialmedia@freedomtimes.news',
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

function harness(env: Record<string, unknown>) {
	const kv = new FakeKv();
	const emails: XAutoEmail[] = [];
	const calls: { url: string; init?: RequestInit }[] = [];
	const logs: string[] = [];
	let now = new Date('2026-11-01T12:44:00.000Z');
	const deps: XAutoDeps = {
		env,
		kv,
		now: () => now,
		sendEmail: async (message) => {
			emails.push(message);
		},
		fetch: async (url, init) => {
			calls.push({ url, init });
			if (url === X_OAUTH2_TOKEN_URL) {
				return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-2', token_type: 'bearer' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({ data: { id: '1234567890' } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		},
		log: (level, message) => logs.push(`${level}:${message}`),
	};
	return {
		deps,
		kv,
		emails,
		calls,
		logs,
		setNow(date: Date) {
			now = date;
		},
	};
}

describe('X post text', () => {
	it('joins headline, hook, and link, and builds an intent URL', () => {
		const draft = composeXPost({
			headline: 'Cult news this week',
			hook: 'A short hook about the week.',
			url: ARTICLE,
		});
		assert.equal(draft.text, `Cult news this week\n\nA short hook about the week.\n\n${ARTICLE}`);
		assert.ok(draft.weightedLength <= X_MAX_WEIGHTED_LENGTH);
		assert.equal(draft.weightedLength, xWeightedLength(draft.text));
		const intent = new URL(draft.intentUrl);
		assert.equal(intent.origin + intent.pathname, 'https://x.com/intent/post');
		assert.equal(intent.searchParams.get('text'), draft.text);
		assert.equal(intentPostUrl('A & B'), 'https://x.com/intent/post?text=A+%26+B');
	});

	it('drops a hook that repeats the headline', () => {
		const draft = composeXPost({ headline: 'Same line', hook: 'Same line', url: ARTICLE });
		assert.equal(draft.text, `Same line\n\n${ARTICLE}`);
	});

	it('counts the link as 23 and keeps a long URL whole', () => {
		const longUrl = `https://freedomtimes.news/posts/${'a'.repeat(80)}`;
		const headline = 'B'.repeat(250);
		const draft = composeXPost({ headline, hook: '', url: longUrl });
		assert.ok(draft.text.endsWith(longUrl));
		assert.ok(draft.weightedLength <= 280);
		assert.equal(xWeightedLength(longUrl), 23);
	});

	it('shortens the hook before the headline, and stays within 280', () => {
		const headline = 'Headline stays';
		const hook = 'H'.repeat(400);
		const draft = composeXPost({ headline, hook, url: ARTICLE });
		assert.ok(draft.text.startsWith(headline));
		assert.ok(draft.text.endsWith(ARTICLE));
		assert.ok(draft.weightedLength <= 280);
		assert.ok(draft.text.includes('…'));
		assert.ok(!draft.text.includes('H'.repeat(400)));
	});

	it('shortens the headline when the hook is already gone and the title is too long', () => {
		const draft = composeXPost({ headline: 'T'.repeat(400), hook: '', url: ARTICLE });
		assert.ok(draft.text.endsWith(ARTICLE));
		assert.ok(draft.text.includes('…'));
		assert.ok(draft.weightedLength <= 280);
		assert.ok(draft.weightedLength > 200);
	});

	it('formats the email clock in UK time', () => {
		assert.equal(formatLondon(new Date('2026-11-01T12:44:00.000Z')), '1 Nov 2026, 12:44 UK');
		assert.equal(formatLondon(new Date('2026-06-01T12:44:00.000Z')), '1 Jun 2026, 13:44 UK');
	});
});

describe('production gate', () => {
	it('sends only when the public Worker is explicitly allowed', () => {
		assert.equal(effectiveXAutoMode({ ...PROD, X_AUTO_POST_MODE: 'intent' }), 'intent');
		assert.equal(effectiveXAutoMode({ ...PROD, X_AUTO_POST_MODE: 'api' }), 'api');
		assert.equal(effectiveXAutoMode({ SITE_ACCESS_MODE: 'public', X_AUTO_POST_MODE: 'api' }), 'dry-run');
		assert.equal(
			effectiveXAutoMode({ SITE_ACCESS_MODE: 'locked', X_AUTO_POST_MODE: 'api', X_AUTO_POST_ALLOW_SEND: 'yes' }),
			'dry-run',
		);
		assert.equal(effectiveXAutoMode({ ...PROD, X_AUTO_POST_MODE: 'off' }), 'off');
		assert.equal(effectiveXAutoMode({}), 'dry-run');
	});
});

describe('publish handler', () => {
	it('dry-run returns the text and intent link and records nothing', async () => {
		const { deps, kv, emails, calls } = harness({
			SITE_ACCESS_MODE: 'locked',
			X_AUTO_POST_MODE: 'api',
			X_AUTO_POST_ALLOW_SEND: 'yes',
			X_OAUTH2_CLIENT_SECRET: 'secret-value',
		});
		const result = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(result.action, 'dry-run');
		assert.match(result.draft?.text ?? '', /Cult news this week/);
		assert.match(result.draft?.intentUrl ?? '', /^https:\/\/x\.com\/intent\/post\?text=/);
		assert.ok((result.draft?.weightedLength ?? 999) <= 280);
		assert.equal(emails.length, 0);
		assert.equal(calls.length, 0);
		assert.equal(kv.data.size, 0);
		assert.equal(JSON.stringify(result).includes('secret-value'), false);
	});

	it('emails the intent link once, then ignores a republish and an edit', async () => {
		const { deps, emails, kv } = harness({ ...PROD, X_AUTO_POST_MODE: 'intent' });
		const first = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(first.action, 'intent');
		assert.equal(emails.length, 1);
		assert.equal(emails[0].to, 'socialmedia@freedomtimes.news');
		assert.match(emails[0].text, /Nothing has been posted to X yet/);
		assert.match(emails[0].text, /1 Nov 2026, 12:44 UK/);
		assert.ok(emails[0].text.includes(first.draft?.intentUrl ?? 'missing'));
		assert.match(emails[0].text, /You press Post/);

		const again = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(again.action, 'skip');
		assert.equal(again.reason, 'already-sent');
		const edited = await handleXAutoPublish(post({ data: { title: 'A rewritten headline', lede: 'New hook' } }), 'posts', deps);
		assert.equal(edited.reason, 'already-sent');
		assert.equal(emails.length, 1);
		const stored = kv.data.get('x-auto:post-1')?.value as XAutoRecord;
		assert.equal(stored.status, 'sent');
		assert.equal(stored.mode, 'intent');
	});

	it('does not record a failed email, so a later publish can retry', async () => {
		const { deps, kv } = harness({ ...PROD, X_AUTO_POST_MODE: 'intent' });
		deps.sendEmail = async () => {
			throw new Error('mailbox unavailable');
		};
		await assert.rejects(() => handleXAutoPublish(post(), 'posts', deps), /mailbox unavailable/);
		assert.equal(kv.data.has('x-auto:post-1'), false);
	});

	it('skips pages, drafts, and posts with no headline', async () => {
		const { deps, emails } = harness({ ...PROD, X_AUTO_POST_MODE: 'intent' });
		assert.equal((await handleXAutoPublish(post(), 'pages', deps)).reason, 'not-a-post');
		assert.equal((await handleXAutoPublish(post({ status: 'draft' }), 'posts', deps)).reason, 'not-a-published-post');
		assert.equal((await handleXAutoPublish(post({ data: { title: '  ' } }), 'posts', deps)).reason, 'no-headline');
		assert.equal(emails.length, 0);
	});

	it('posts through a mocked X client once, stores the rotated refresh token, and does not post again', async () => {
		const { deps, calls, emails, kv, logs } = harness({
			...PROD,
			X_AUTO_POST_MODE: 'api',
			X_OAUTH2_CLIENT_ID: 'client-id',
			X_OAUTH2_CLIENT_SECRET: 'client-secret',
			X_OAUTH2_REFRESH_TOKEN: 'refresh-1',
		});
		const result = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(result.action, 'api');
		assert.equal(result.tweetUrl, 'https://x.com/i/web/status/1234567890');
		assert.equal(calls.length, 2);
		assert.equal(calls[0].url, X_OAUTH2_TOKEN_URL);
		assert.match(String(calls[0].init?.body), /grant_type=refresh_token/);
		assert.match(String(calls[0].init?.headers && (calls[0].init.headers as Record<string, string>).authorization), /^Basic /);
		assert.equal(calls[1].url, 'https://api.x.com/2/tweets');
		const tweetHeaders = calls[1].init?.headers as Record<string, string>;
		assert.equal(tweetHeaders.authorization, 'Bearer access-1');
		assert.equal(JSON.parse(String(calls[1].init?.body)).text, result.draft?.text);
		assert.equal((kv.data.get('oauth2-refresh-token')?.value as { token: string }).token, 'refresh-2');
		assert.equal(emails.length, 1);
		assert.match(emails[0].text, /https:\/\/x\.com\/i\/web\/status\/1234567890/);
		assert.equal(JSON.stringify(logs).includes('client-secret'), false);
		assert.equal(JSON.stringify(logs).includes('refresh-1'), false);
		assert.equal(JSON.stringify(emails).includes('client-secret'), false);

		calls.length = 0;
		const second = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(second.reason, 'already-sent');
		assert.equal(calls.length, 0);
	});

	it('releases the claim when X refuses the tweet, and keeps it when the outcome is unknown', async () => {
		const refused = harness({
			...PROD,
			X_AUTO_POST_MODE: 'api',
			X_OAUTH2_CLIENT_ID: 'client-id',
			X_OAUTH2_CLIENT_SECRET: 'client-secret',
			X_OAUTH2_REFRESH_TOKEN: 'refresh-1',
		});
		refused.deps.fetch = async (url) => {
			if (url === X_OAUTH2_TOKEN_URL) {
				return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-2' }), { status: 200 });
			}
			return new Response(JSON.stringify({ detail: 'Credits depleted' }), { status: 402 });
		};
		await assert.rejects(() => handleXAutoPublish(post(), 'posts', refused.deps), /Credits depleted/);
		assert.equal(refused.kv.data.has('x-auto:post-1'), false);
		assert.equal((refused.kv.data.get('oauth2-refresh-token')?.value as { token: string }).token, 'refresh-2');

		const lost = harness({
			...PROD,
			X_AUTO_POST_MODE: 'api',
			X_OAUTH2_CLIENT_ID: 'client-id',
			X_OAUTH2_CLIENT_SECRET: 'client-secret',
			X_OAUTH2_REFRESH_TOKEN: 'refresh-1',
		});
		lost.deps.fetch = async (url) => {
			if (url === X_OAUTH2_TOKEN_URL) {
				return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-2' }), { status: 200 });
			}
			throw new Error('socket hang up');
		};
		await assert.rejects(() => handleXAutoPublish(post(), 'posts', lost.deps), /may or may not have posted/);
		assert.equal((lost.kv.data.get('x-auto:post-1')?.value as XAutoRecord).status, 'pending');

		lost.setNow(new Date(Date.parse('2026-11-01T12:44:00.000Z') + X_AUTO_STALE_PENDING_MS + 1000));
		lost.deps.fetch = async (url) => {
			if (url === X_OAUTH2_TOKEN_URL) {
				return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-3' }), { status: 200 });
			}
			return new Response(JSON.stringify({ data: { id: '1234567890' } }), { status: 200 });
		};
		const retried = await handleXAutoPublish(post(), 'posts', lost.deps);
		assert.equal(retried.action, 'api');
	});

	it('a fresh pending claim blocks a second sender', async () => {
		const { deps } = harness({ ...PROD, X_AUTO_POST_MODE: 'intent' });
		await deps.kv.set('x-auto:post-1', {
			status: 'pending',
			mode: 'intent',
			text: 'in flight',
			at: deps.now().toISOString(),
		} satisfies XAutoRecord);
		const result = await handleXAutoPublish(post(), 'posts', deps);
		assert.equal(result.reason, 'in-progress');
	});
});

describe('plugin registration', () => {
	it('astro.config grants exactly the capabilities and hosts the plugin declares', () => {
		const src = readFileSync(new URL('../src/plugins/x-auto-post.ts', import.meta.url), 'utf8');
		assert.match(src, /capabilities: \[\.\.\.X_AUTO_CAPABILITIES\]/);
		assert.match(src, /allowedHosts: \[\.\.\.X_AUTO_ALLOWED_HOSTS\]/);
		assert.match(src, /content:afterPublish/);
		assert.doesNotMatch(src, /public\s*:\s*true/);
		const config = readFileSync(new URL('../astro.config.ts', import.meta.url), 'utf8');
		const descriptor = /id: 'ft-x-auto-post',[\s\S]*?allowedHosts: \[[^\]]*\]/.exec(config)?.[0] ?? '';
		const list = (name: string) =>
			[...(new RegExp(`${name}: \\[([^\\]]*)\\]`).exec(descriptor)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
		assert.deepEqual(list('capabilities'), [...X_AUTO_CAPABILITIES]);
		assert.deepEqual(list('allowedHosts'), [...X_AUTO_ALLOWED_HOSTS]);
	});

	it('production wrangler turns Stage A on, and staging cannot send', () => {
		const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
		const production = /"production": \{[\s\S]*?\n\t\t\}/.exec(wrangler)?.[0] ?? '';
		const staging = /"staging": \{[\s\S]*$/.exec(wrangler)?.[0] ?? '';
		assert.match(production, /"X_AUTO_POST_MODE": "intent"/);
		assert.match(production, /"X_AUTO_POST_ALLOW_SEND": "yes"/);
		assert.match(staging, /"X_AUTO_POST_MODE": "dry-run"/);
		assert.doesNotMatch(staging, /X_AUTO_POST_ALLOW_SEND/);
	});
});
