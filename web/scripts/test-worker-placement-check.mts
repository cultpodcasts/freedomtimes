import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ASSET_PROBE_CACHE_BUST_PARAM,
	classifyAssetProbe,
	DEFAULT_PROBE_ATTEMPTS,
	DEFAULT_PROBE_DELAY_MS,
	DEFAULT_ASSET_PROBE_PATH,
	DEFAULT_UNMATCHED_PROBE_PATH,
	evaluateWorker,
	expectedFromWrangler,
	hasAssetsFromApi,
	isPlausibleCloudflareApiToken,
	parseEnvFileValues,
	parseJsonc,
	parseServerTiming,
	placementFromService,
	probeStaticAsset,
	probeUnmatchedRoute,
	probeWithRetry,
	redactUrl,
	scriptFromService,
	sampleServerTimings,
	selectCloudflareApiToken,
	SITE_ORIGINS,
	summarizeDbTiming,
	TOKEN_ENV_FILE_KEYS,
	verifierExitCode,
	withCacheBust,
} from './lib/worker-placement-check.mjs';

const wrangler = parseJsonc(readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8'));

// Shape returned by GET /accounts/{a}/workers/services/{name} for staging on 2026-10-27.
const service = (placement: unknown, lastDeployedFrom = 'wrangler') => ({
	id: 'freedomtimes-staging',
	default_environment: { environment: 'production', script: { placement, last_deployed_from: lastDeployedFrom } },
});
const PLACED = { mode: 'targeted', target: [{ id: 11, region: 'aws:eu-west-1', type: 'region' }] };
type Binding = { name: string; type: string; text?: string };
const bindings = (pageCache: string, extra: Binding[] = []): Binding[] => [
	{ name: 'ASSETS', type: 'assets' },
	{ name: 'PAGE_CACHE', type: 'plain_text', text: pageCache },
	{ name: 'SITE_ACCESS_MODE', type: 'plain_text', text: 'locked' },
	{ name: 'TURSO_AUTH_TOKEN', type: 'secret_text' },
	...extra,
];

describe('verify-worker-placement: wrangler.jsonc expectations', () => {
	it('parses the real wrangler.jsonc (comments, trailing commas)', () => {
		const staging = expectedFromWrangler(wrangler, 'staging');
		assert.equal(staging.workerName, 'freedomtimes-staging');
		assert.equal(staging.placementRegion, 'aws:eu-west-1');
		assert.equal(staging.plainText.PAGE_CACHE, 'off');
		assert.equal(staging.plainText.SITE_ACCESS_MODE, 'locked');
		assert.equal(staging.hasAssets, true);
		// The @astrojs/cloudflare entry calls env.ASSETS.fetch() for unmatched routes; without this binding
		// every unmatched URL was a 500 on both environments (Workers logs, 27 Oct 2026).
		assert.equal(staging.assetsBinding, 'ASSETS', 'web/wrangler.jsonc must set assets.binding = "ASSETS"');
		assert.equal(expectedFromWrangler(wrangler, 'production').assetsBinding, 'ASSETS');
		const prod = expectedFromWrangler(wrangler, 'production');
		assert.equal(prod.workerName, 'freedomtimes');
		assert.equal(prod.plainText.PAGE_CACHE, 'on');
		assert.equal(prod.plainText.PAGE_CACHE_TTL_SECONDS, '120');
		assert.equal(prod.placementRegion, 'aws:eu-west-1');
	});

	it('parseJsonc keeps // inside strings', () => {
		assert.deepEqual(parseJsonc('{ "u": "https://x//y", /* c */ "a": [1,], // t\n }'), { u: 'https://x//y', a: [1] });
	});
});

describe('verify-worker-placement: evaluation', () => {
	const staging = expectedFromWrangler(wrangler, 'staging');

	it('OK for targeted aws:eu-west-1 + matching vars', () => {
		const r = evaluateWorker(staging, placementFromService(service(PLACED)), bindings('off'));
		assert.deepEqual(r.failures, []);
		assert.equal(r.ok, true);
	});

	it('fails when placement was reset (empty placement, as production before #111)', () => {
		const r = evaluateWorker(staging, placementFromService(service({})), bindings('off'));
		assert.equal(r.ok, false);
		assert.match(r.failures.join('\n'), /mode is null, expected "targeted"/);
		assert.match(r.failures.join('\n'), /region is \[\], expected aws:eu-west-1/);
	});

	it('fails when the region differs', () => {
		const r = evaluateWorker(staging, placementFromService(service({ mode: 'targeted', target: [{ region: 'aws:us-east-1' }] })), bindings('off'));
		assert.match(r.failures.join('\n'), /expected aws:eu-west-1/);
	});

	it('fails when PAGE_CACHE was switched off/removed in production', () => {
		const prod = expectedFromWrangler(wrangler, 'production');
		const prodBindings = (pc?: string): Binding[] => [
			{ name: 'ASSETS', type: 'assets' },
			{ name: 'SITE_ACCESS_MODE', type: 'plain_text', text: 'public' },
			{ name: 'PAGE_CACHE_TTL_SECONDS', type: 'plain_text', text: '120' },
			...(pc ? [{ name: 'PAGE_CACHE', type: 'plain_text', text: pc }] : []),
		];
		assert.equal(evaluateWorker(prod, placementFromService(service(PLACED)), prodBindings('on')).ok, true);
		assert.match(evaluateWorker(prod, placementFromService(service(PLACED)), prodBindings('off')).failures.join('\n'), /PAGE_CACHE="off", wrangler.jsonc sets "on"/);
		assert.match(evaluateWorker(prod, placementFromService(service(PLACED)), prodBindings()).failures.join('\n'), /binding PAGE_CACHE is missing/);
	});

	it('fails when a non-Wrangler upload was last', () => {
		assert.match(
			evaluateWorker(staging, placementFromService(service(PLACED, 'terraform')), bindings('off')).failures.join('\n'),
			/last_deployed_from is "terraform"/,
		);
	});

	it('fails on a failed placement status, tolerates absent status', () => {
		assert.match(
			evaluateWorker(staging, placementFromService(service({ ...PLACED, status: 'UNSUPPORTED_APPLICATION' })), bindings('off')).failures.join('\n'),
			/placement status UNSUPPORTED_APPLICATION/,
		);
	});

	it('accepts the flat placement_mode / region shapes', () => {
		const p = placementFromService({ script: { placement_mode: 'targeted', placement: { region: 'aws:eu-west-1' }, last_deployed_from: 'wrangler' } });
		assert.equal(p.mode, 'targeted');
		assert.deepEqual(p.regions, ['aws:eu-west-1']);
	});
});

describe('verify-worker-placement: Server-Timing sanity', () => {
	it('parses Server-Timing', () => {
		assert.deepEqual(parseServerTiming('rt;dur=341, rt.db;dur=180, db.total;dur=121, db.count;dur=3, x'), {
			rt: 341,
			'rt.db': 180,
			'db.total': 121,
			'db.count': 3,
			x: 0,
		});
		assert.deepEqual(parseServerTiming(null), {});
	});

	it('median ms/query: placed vs unplaced (27 Oct baseline numbers)', () => {
		const placed = summarizeDbTiming([{ 'db.total': 121, 'db.count': 3 }, { 'db.total': 100, 'db.count': 3 }, { 'db.total': 87, 'db.count': 3 }]);
		assert.equal(placed.ok, true);
		const unplaced = summarizeDbTiming([{ 'db.total': 530, 'db.count': 3 }, { 'db.total': 576, 'db.count': 3 }, { 'db.total': 522, 'db.count': 3 }]);
		assert.equal(unplaced.ok, false);
		assert.equal(summarizeDbTiming([{ rt: 5 }]).samples, 0);
	});
});

describe('verify-worker-placement: token selection', () => {
	const real = 'r'.repeat(40);
	const realTf = 't'.repeat(53);
	const stub = 'F'.repeat(31);

	it('plausibility matches Test-DeployCloudflareApiTokenPlausible (40+ chars, no whitespace)', () => {
		assert.equal(isPlausibleCloudflareApiToken(''), false);
		assert.equal(isPlausibleCloudflareApiToken(stub), false);
		assert.equal(isPlausibleCloudflareApiToken(`${'c'.repeat(20)} ${'d'.repeat(20)}`), false);
		assert.equal(isPlausibleCloudflareApiToken(undefined), false);
		assert.equal(isPlausibleCloudflareApiToken(real), true);
		assert.equal(isPlausibleCloudflareApiToken(`  ${real}  `), true);
	});

	it('skips the short CLOUDFLARE_API_TOKEN stub and uses TF_VAR_CLOUDFLARE_API_TOKEN', () => {
		const r = selectCloudflareApiToken({ CLOUDFLARE_API_TOKEN: stub, TF_VAR_CLOUDFLARE_API_TOKEN: realTf });
		assert.equal(r.token, realTf);
		assert.equal(r.source, 'env TF_VAR_CLOUDFLARE_API_TOKEN');
		assert.deepEqual(r.skipped, ['env CLOUDFLARE_API_TOKEN']);
	});

	it('finds the lowercase TF_VAR_cloudflare_api_token that terraform-run.ps1 sets', () => {
		const r = selectCloudflareApiToken({ TF_VAR_cloudflare_api_token: realTf });
		assert.equal(r.token, realTf);
		assert.equal(r.source, 'env TF_VAR_cloudflare_api_token');
	});

	it('prefers a plausible CLOUDFLARE_API_TOKEN, then falls back to --env-file values', () => {
		assert.equal(selectCloudflareApiToken({ CLOUDFLARE_API_TOKEN: real, TF_VAR_CLOUDFLARE_API_TOKEN: realTf }).token, real);
		const r = selectCloudflareApiToken({ CLOUDFLARE_API_TOKEN: stub }, { TF_VAR_CLOUDFLARE_API_TOKEN: realTf });
		assert.equal(r.token, realTf);
		assert.equal(r.source, '--env-file TF_VAR_CLOUDFLARE_API_TOKEN');
	});

	it('returns no token (exit 2 path) when every candidate is a stub, and never echoes values', () => {
		const r = selectCloudflareApiToken({ CLOUDFLARE_API_TOKEN: stub }, { CLOUDFLARE_API_TOKEN: 'short' });
		assert.equal(r.token, undefined);
		assert.deepEqual(r.skipped, ['env CLOUDFLARE_API_TOKEN', '--env-file CLOUDFLARE_API_TOKEN']);
		assert.ok(!JSON.stringify(r).includes(stub));
	});
});

describe('verify-worker-placement: --env-file parsing', () => {
	const tok = 'a'.repeat(40);

	it('trims trailing whitespace and strips unquoted inline comments', () => {
		const v = parseEnvFileValues(`TF_VAR_CLOUDFLARE_API_TOKEN=${tok}   \t\nCLOUDFLARE_API_TOKEN=${tok}  # rotated 2026-10\n`, TOKEN_ENV_FILE_KEYS);
		assert.equal(v.TF_VAR_CLOUDFLARE_API_TOKEN, tok);
		assert.equal(v.CLOUDFLARE_API_TOKEN, tok);
	});

	it('handles quotes, export prefix, CRLF, BOM, comments and blank lines', () => {
		const text = `\uFEFF# comment\r\n\r\nexport CLOUDFLARE_API_TOKEN="${tok}" # note\r\nTF_VAR_cloudflare_api_token='${tok}'\r\n`;
		const v = parseEnvFileValues(text, TOKEN_ENV_FILE_KEYS);
		assert.equal(v.CLOUDFLARE_API_TOKEN, tok);
		assert.equal(v.TF_VAR_cloudflare_api_token, tok);
	});

	it('first non-empty occurrence wins; other keys are never read', () => {
		const v = parseEnvFileValues(`CLOUDFLARE_API_TOKEN=\nCLOUDFLARE_API_TOKEN=${tok}\nCLOUDFLARE_API_TOKEN=${'b'.repeat(40)}\nTURSO_AUTH_TOKEN=secret\n`, TOKEN_ENV_FILE_KEYS);
		assert.deepEqual(v, { CLOUDFLARE_API_TOKEN: tok });
	});

	it('keeps a # that is part of an unspaced value', () => {
		assert.equal(parseEnvFileValues('CLOUDFLARE_API_TOKEN=abc#def', TOKEN_ENV_FILE_KEYS).CLOUDFLARE_API_TOKEN, 'abc#def');
	});
});

describe('verify-worker-placement: Server-Timing sampling network errors', () => {
	it('a DNS / network failure is reported as an error (exit 2 path), without headers or query string', async () => {
		const failing = (async () => {
			throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
		}) as unknown as typeof fetch;
		const r = await sampleServerTimings({ url: 'https://nope.invalid/homepage?token=abc', samples: 3, headers: { cookie: 'session=SECRET' }, fetchImpl: failing });
		assert.ok('error' in r);
		assert.match(r.error, /nope\.invalid\/homepage failed: fetch failed \(ENOTFOUND\)/);
		assert.ok(!r.error.includes('SECRET'));
		assert.ok(!r.error.includes('token=abc'));
	});

	it('discards the first (cold) sample and parses the rest', async () => {
		let n = 0;
		const ok = (async () => {
			n += 1;
			return new Response('x', { headers: { 'server-timing': `db.total;dur=${n * 10}, db.count;dur=1` } });
		}) as unknown as typeof fetch;
		const r = await sampleServerTimings({ url: 'https://example.test/', samples: 3, fetchImpl: ok });
		assert.ok('timings' in r);
		assert.deepEqual(r.timings.map((t) => t['db.total']), [20, 30]);
	});

	it('redactUrl keeps origin + path only', () => {
		assert.equal(redactUrl('https://a.test/p/q?x=1#h'), 'https://a.test/p/q');
		assert.equal(redactUrl('not a url'), '(invalid URL)');
	});
});

describe('verify-worker-placement: static assets', () => {
	const withBinding = expectedFromWrangler(wrangler, 'staging');
	const noBindingName = { ...withBinding, assetsBinding: undefined };
	// Live staging settings from deploy 8fc44eb5 (27 Oct): assets uploaded, but no ASSETS binding.
	const liveWithoutAssetsBinding = bindings('off').filter((b) => b.type !== 'assets');

	it('assets.binding set in wrangler.jsonc and present in the live settings: OK', () => {
		const r = evaluateWorker(withBinding, placementFromService(service(PLACED)), bindings('off', [{ name: 'ASSETS', type: 'assets' }]), { apiHasAssets: true });
		assert.deepEqual(r.failures, []);
	});

	it('assets.binding set but missing (or wrong type) in the live settings: mismatch (staging deploy 8fc44eb5)', () => {
		const missing = evaluateWorker(withBinding, placementFromService(service(PLACED)), liveWithoutAssetsBinding, { apiHasAssets: true });
		assert.equal(missing.ok, false);
		assert.match(missing.failures.join('\n'), /assets binding ASSETS is missing/);
		const wrongType = evaluateWorker(withBinding, placementFromService(service(PLACED)), [...liveWithoutAssetsBinding, { name: 'ASSETS', type: 'r2_bucket' }]);
		assert.match(wrongType.failures.join('\n'), /binding ASSETS has type r2_bucket, expected assets/);
	});

	it('no binding name configured: no binding required, has_assets decides', () => {
		const r = evaluateWorker(noBindingName, placementFromService(service(PLACED)), liveWithoutAssetsBinding, { apiHasAssets: true });
		assert.deepEqual(r.failures, []);
		assert.match(r.notes.join('\n'), /without a binding name/);
		assert.match(r.notes.join('\n'), /has_assets true/);
		const unknown = evaluateWorker(noBindingName, placementFromService(service(PLACED)), liveWithoutAssetsBinding);
		assert.deepEqual(unknown.failures, []);
		assert.match(unknown.notes.join('\n'), /has_assets \(not reported by the API\)/);
	});

	it('Cloudflare reporting has_assets=false is a mismatch', () => {
		const r = evaluateWorker(withBinding, placementFromService(service(PLACED)), bindings('off'), { apiHasAssets: false });
		assert.match(r.failures.join('\n'), /has_assets=false/);
	});

	it('hasAssetsFromApi: service script first, then the GET /workers/scripts list entry (id = name)', () => {
		assert.equal(hasAssetsFromApi({ default_environment: { script: { has_assets: true } } }, undefined, 'freedomtimes-staging'), true);
		const list = [
			{ id: 'freedomtimes', has_assets: false },
			{ id: 'freedomtimes-staging', has_assets: true },
		];
		assert.equal(hasAssetsFromApi(service(PLACED), list, 'freedomtimes-staging'), true);
		assert.equal(hasAssetsFromApi(service(PLACED), list, 'freedomtimes'), false);
		assert.equal(hasAssetsFromApi(service(PLACED), [{ id: 'freedomtimes-staging' }], 'freedomtimes-staging'), undefined);
		assert.equal(hasAssetsFromApi(service(PLACED), undefined, 'freedomtimes-staging'), undefined);
	});

	it('default probe path is a real file in web/public (copied to dist/client by astro build); origins are each env own', () => {
		assert.ok(existsSync(fileURLToPath(new URL(`../public${DEFAULT_ASSET_PROBE_PATH}`, import.meta.url))));
		assert.equal(SITE_ORIGINS.staging, 'https://staging.freedomtimes.news');
		assert.equal(SITE_ORIGINS.production, 'https://freedomtimes.news');
	});

	const fakeFetch = (status: number, headers: Record<string, string>, body = 'x') =>
		(async (_url: string, init?: RequestInit) => {
			assert.equal(init?.redirect, 'manual');
			assert.equal((init?.headers as Record<string, string> | undefined)?.cookie, undefined, 'probe is logged out');
			return new Response(body, { status, headers });
		}) as unknown as typeof fetch;

	it('probe 200 + image/svg+xml (staging logged out, 27 Oct): ok, exit 0', async () => {
		const p = await probeStaticAsset({ url: 'https://staging.freedomtimes.news/favicon.svg', fetchImpl: fakeFetch(200, { 'content-type': 'image/svg+xml' }) });
		const c = classifyAssetProbe(p);
		assert.equal(c.outcome, 'ok');
		assert.equal(verifierExitCode({ mismatch: false, unverified: [] }), 0);
	});

	it('probe 404 HTML: mismatch, exit 1', async () => {
		const p = await probeStaticAsset({ url: 'https://freedomtimes.news/favicon.svg', fetchImpl: fakeFetch(404, { 'content-type': 'text/html; charset=utf-8' }, '<html>') });
		const c = classifyAssetProbe(p);
		assert.equal(c.outcome, 'mismatch');
		assert.match(c.message, /returned HTTP 404/);
		assert.equal(verifierExitCode({ mismatch: true, unverified: [] }), 1);
	});

	it('probe 200 but HTML (the Worker answered): mismatch', async () => {
		const p = await probeStaticAsset({ url: 'https://freedomtimes.news/favicon.svg', fetchImpl: fakeFetch(200, { 'content-type': 'text/html; charset=utf-8' }, '<html>') });
		assert.equal(classifyAssetProbe(p).outcome, 'mismatch');
		assert.match(classifyAssetProbe(p).message, /non-HTML/);
	});

	it('probe 302 to the staging login wall (asset missing, fell through to the Worker): mismatch, location path only', async () => {
		const p = await probeStaticAsset({
			url: 'https://staging.freedomtimes.news/favicon.svg',
			fetchImpl: fakeFetch(302, { location: 'https://login.example/authorize?state=SECRET' }, ''),
		});
		const c = classifyAssetProbe(p);
		assert.equal(c.outcome, 'mismatch');
		assert.match(c.message, /HTTP 302 \(location https:\/\/login\.example\/authorize\)/);
		assert.ok(!c.message.includes('SECRET'));
	});

	it('probe network error: unverified, exit 2; a mismatch elsewhere still wins (exit 1)', async () => {
		const failing = (async () => {
			throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
		}) as unknown as typeof fetch;
		const p = await probeStaticAsset({ url: 'https://staging.freedomtimes.news/favicon.svg?x=SECRET', fetchImpl: failing });
		const c = classifyAssetProbe(p);
		assert.equal(c.outcome, 'unverified');
		assert.match(c.message, /favicon\.svg failed: fetch failed \(ECONNREFUSED\)/);
		assert.ok(!c.message.includes('SECRET'));
		assert.equal(verifierExitCode({ mismatch: false, unverified: [c.message] }), 2);
		assert.equal(verifierExitCode({ mismatch: true, unverified: [c.message] }), 1);
	});

	it('unmatched route 500 (env.ASSETS unbound, as on 27 Oct): mismatch; 404 or the staging 302: ok; network error: unverified', async () => {
		const url = `https://freedomtimes.news${DEFAULT_UNMATCHED_PROBE_PATH}`;
		const c500 = classifyAssetProbe(await probeUnmatchedRoute({ url, fetchImpl: fakeFetch(500, { 'content-type': 'text/plain; charset=UTF-8' }) }));
		assert.equal(c500.outcome, 'mismatch');
		assert.match(c500.message, /returned HTTP 500.*env\.ASSETS is unbound/);
		assert.equal(classifyAssetProbe(await probeUnmatchedRoute({ url, fetchImpl: fakeFetch(404, { 'content-type': 'text/html' }) })).outcome, 'ok');
		assert.equal(classifyAssetProbe(await probeUnmatchedRoute({ url, fetchImpl: fakeFetch(302, { location: '/' }, '') })).outcome, 'ok');
		const failing = (async () => {
			throw new TypeError('fetch failed');
		}) as unknown as typeof fetch;
		assert.equal(classifyAssetProbe(await probeUnmatchedRoute({ url, fetchImpl: failing })).outcome, 'unverified');
	});

	it('unmatched route 400 (e.g. a "Missing slug" answer until #119): ok — the probe checks "no 5xx", not "is 404"', async () => {
		const url = `https://freedomtimes.news${DEFAULT_UNMATCHED_PROBE_PATH}`;
		const c = classifyAssetProbe(await probeUnmatchedRoute({ url, fetchImpl: fakeFetch(400, { 'content-type': 'text/plain' }) }));
		assert.equal(c.outcome, 'ok');
	});

	it('static asset probe URL is cache-busted with ?ft-verify=<ms>; redactUrl drops it; cf-cache-status is logged', async () => {
		const busted = withCacheBust('https://staging.freedomtimes.news/favicon.svg', 1761523200000);
		assert.equal(busted, `https://staging.freedomtimes.news/favicon.svg?${ASSET_PROBE_CACHE_BUST_PARAM}=1761523200000`);
		assert.equal(withCacheBust('https://x.test/a.svg?v=1', 5), 'https://x.test/a.svg?v=1&ft-verify=5');
		assert.equal(redactUrl(busted), 'https://staging.freedomtimes.news/favicon.svg');
		let seen = '';
		const fetchImpl = (async (u: string, init?: RequestInit) => {
			seen = u;
			assert.equal(init?.redirect, 'manual');
			return new Response('x', { status: 200, headers: { 'content-type': 'image/svg+xml', 'cf-cache-status': 'MISS' } });
		}) as unknown as typeof fetch;
		const c = classifyAssetProbe(await probeStaticAsset({ url: busted, fetchImpl }));
		assert.equal(seen, busted);
		assert.equal(c.outcome, 'ok');
		assert.match(c.message, /cf-cache-status MISS/);
		const verifier = readFileSync(fileURLToPath(new URL('./verify-worker-placement.mjs', import.meta.url)), 'utf8');
		assert.match(verifier, /withCacheBust\(`\$\{origin\}\$\{assetPath\}`\)/, 'verifier busts the cache on every static asset attempt');
		assert.match(verifier, /probeWithRetry\(/, 'verifier retries the live probes');
	});

	it('scriptFromService: default_environment.script, then .script, then the result itself', () => {
		assert.deepEqual(scriptFromService({ default_environment: { script: { a: 1 } }, script: { a: 2 } }), { a: 1 });
		assert.deepEqual(scriptFromService({ script: { a: 2 } }), { a: 2 });
		assert.deepEqual(scriptFromService({ a: 3 }), { a: 3 });
		assert.deepEqual(scriptFromService(undefined), {});
	});
});

describe('verify-worker-placement: live probe retries', () => {
	const url = `https://freedomtimes.news${DEFAULT_UNMATCHED_PROBE_PATH}`;
	const sequence = (steps: Array<number | 'neterr'>) => {
		let i = 0;
		return (async () => {
			const step = steps[Math.min(i++, steps.length - 1)];
			if (step === 'neterr') throw new TypeError('fetch failed');
			return new Response('x', { status: step, headers: { 'content-type': 'text/html' } });
		}) as unknown as typeof fetch;
	};
	const run = async (steps: Array<number | 'neterr'>) => {
		const lines: string[] = [];
		const sleeps: number[] = [];
		const result = await probeWithRetry({
			probe: probeUnmatchedRoute,
			makeUrl: () => url,
			fetchImpl: sequence(steps),
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
			log: (l: string) => lines.push(l),
			label: 'unmatched route',
		});
		return { result, lines, sleeps, c: classifyAssetProbe(result) };
	};

	it('defaults: 4 attempts, 5 s apart', () => {
		assert.equal(DEFAULT_PROBE_ATTEMPTS, 4);
		assert.equal(DEFAULT_PROBE_DELAY_MS, 5000);
	});

	it('500 then 404: ok after 2 attempts, one 5 s wait, each attempt logged with status only', async () => {
		const { c, lines, sleeps, result } = await run([500, 404]);
		assert.equal(c.outcome, 'ok');
		assert.equal(result.attempts, 2);
		assert.deepEqual(sleeps, [5000]);
		assert.deepEqual(lines, ['unmatched route attempt 1/4: HTTP 500 (not ok)', 'unmatched route attempt 2/4: HTTP 404']);
	});

	it('500 on every attempt: mismatch (exit 1) after 4 attempts', async () => {
		const { c, lines, sleeps } = await run([500, 500, 500, 500]);
		assert.equal(c.outcome, 'mismatch');
		assert.match(c.message, /HTTP 500.*\(after 4 attempts\)/);
		assert.equal(lines.length, 4);
		assert.deepEqual(sleeps, [5000, 5000, 5000]);
	});

	it('network error on every attempt: unverified (exit 2), never a mismatch', async () => {
		const { c, lines } = await run(['neterr']);
		assert.equal(c.outcome, 'unverified');
		assert.match(c.message, /\(after 4 attempts\)/);
		assert.deepEqual(lines, [1, 2, 3, 4].map((n) => `unmatched route attempt ${n}/4: network error`));
	});

	it('a 5xx seen before network errors is still a mismatch; network error then 404 is ok', async () => {
		assert.equal((await run([502, 'neterr'])).c.outcome, 'mismatch');
		assert.equal((await run(['neterr', 404])).c.outcome, 'ok');
	});

	it('static asset retries too, with a fresh cache-buster per attempt', async () => {
		const urls: string[] = [];
		let n = 0;
		const fetchImpl = (async (u: string) => {
			urls.push(u);
			n++;
			return n === 1
				? new Response('<html>', { status: 404, headers: { 'content-type': 'text/html' } })
				: new Response('x', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
		}) as unknown as typeof fetch;
		const result = await probeWithRetry({
			probe: probeStaticAsset,
			makeUrl: (attempt: number) => withCacheBust('https://freedomtimes.news/favicon.svg', 1000 + attempt),
			fetchImpl,
			sleep: async () => {},
		});
		assert.equal(classifyAssetProbe(result).outcome, 'ok');
		assert.deepEqual(urls, ['https://freedomtimes.news/favicon.svg?ft-verify=1001', 'https://freedomtimes.news/favicon.svg?ft-verify=1002']);
	});
});
