#!/usr/bin/env node
// Read-only check that the deployed Worker runs with the placement and plain_text vars that
// web/wrangler.jsonc declares (PAGE_CACHE, PAGE_CACHE_TTL_SECONDS, SITE_ACCESS_MODE), still has its
// static assets (the `assets.binding` wrangler.jsonc names, `has_assets`, a logged-out GET of a static file
// and of an unmatched route on the environment's own public origin), and was last deployed by Wrangler. Optionally
// samples Server-Timing DB time.
//
// Usage (from web/):
//   node scripts/verify-worker-placement.mjs --env staging|production [--url https://host/path] [--samples 5]
//        [--cookie-env FT_STAGING_COOKIE] [--max-ms-per-query 60] [--strict-timing] [--env-file ../.env.dev]
//        [--asset-origin https://host] [--asset-path /favicon.svg] [--no-asset-probe]
//
// Asset probes (no cookies, redirects not followed): GET <origin><asset-path>?ft-verify=<ms> (cache-busted)
// must be HTTP 200 with a non-HTML content-type, and GET <origin>/__ft-verify/no-such-route/a/b must not be
// 5xx (an unbound env.ASSETS makes every unmatched route 500; any 4xx/3xx passes). Each probe retries up to
// 4 attempts, 5 s apart, before a failure counts; every attempt's status is logged (no headers/cookies). Origin defaults to SITE_ORIGINS[env] (staging.freedomtimes.news / freedomtimes.news); static
// assets are served before the Worker, so the staging login wall does not apply. The path must exist in
// dist/client or public/ (default /favicon.svg), otherwise exit 2.
//
// Auth: the first plausible token (40+ chars, no whitespace, same rule as the deploy scripts) from
// CLOUDFLARE_API_TOKEN, TF_VAR_CLOUDFLARE_API_TOKEN, TF_VAR_cloudflare_api_token, then the same keys in
// --env-file (only those keys are read). A short process stub is skipped. The token and its length are
// never printed; only the source name is. Account id comes from CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc.
// Only GET requests are made.
//
// Exit codes: 0 OK, 1 mismatch, 2 usage / auth / API / network error (a mismatch found elsewhere wins).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	classifyAssetProbe,
	DEFAULT_ASSET_PROBE_PATH,
	DEFAULT_UNMATCHED_PROBE_PATH,
	evaluateWorker,
	expectedFromWrangler,
	hasAssetsFromApi,
	parseEnvFileValues,
	parseJsonc,
	placementFromService,
	probeStaticAsset,
	probeUnmatchedRoute,
	probeWithRetry,
	redactUrl,
	sampleServerTimings,
	selectCloudflareApiToken,
	SITE_ORIGINS,
	summarizeDbTiming,
	TOKEN_ENV_FILE_KEYS,
	verifierExitCode,
	withCacheBust,
} from './lib/worker-placement-check.mjs';

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);

function readEnvFileValues(path) {
	try {
		return parseEnvFileValues(readFileSync(path, 'utf8'), TOKEN_ENV_FILE_KEYS);
	} catch {
		console.error(`[verify-worker-placement] cannot read --env-file ${path}`);
		return {};
	}
}

async function cfGet(path, token) {
	const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
	let body;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	if (!res.ok || !body?.success) {
		const errs = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
		throw new Error(`GET ${path} -> HTTP ${res.status} ${errs}`);
	}
	return body.result;
}

async function main() {
	const env = arg('--env');
	if (env !== 'staging' && env !== 'production') {
		console.error('usage: node scripts/verify-worker-placement.mjs --env staging|production [--url URL] [--samples N]');
		return 2;
	}
	const wrangler = parseJsonc(readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8'));
	const expected = expectedFromWrangler(wrangler, env);
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || expected.accountId;
	const envFile = arg('--env-file');
	const { token, source, skipped } = selectCloudflareApiToken(process.env, envFile ? readEnvFileValues(envFile) : {});
	if (skipped.length > 0) console.log(`[verify-worker-placement] skipped implausible token(s) (stub or malformed): ${skipped.join(', ')}`);
	if (!token || !accountId) {
		console.error(
			'[verify-worker-placement] no usable Cloudflare API token (CLOUDFLARE_API_TOKEN, TF_VAR_CLOUDFLARE_API_TOKEN, TF_VAR_cloudflare_api_token or --env-file) or no CLOUDFLARE_ACCOUNT_ID.',
		);
		return 2;
	}
	console.log(`[verify-worker-placement] token source: ${source}`);

	let service;
	let settings;
	let apiHasAssets;
	try {
		service = await cfGet(`/accounts/${accountId}/workers/services/${expected.workerName}`, token);
		settings = await cfGet(`/accounts/${accountId}/workers/scripts/${expected.workerName}/settings`, token);
	} catch (err) {
		console.error(`[verify-worker-placement] Cloudflare API error: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	apiHasAssets = hasAssetsFromApi(service, undefined, expected.workerName);
	if (expected.hasAssets && apiHasAssets === undefined) {
		// Documented on the script list object (GET /workers/scripts): "has_assets: Whether a Worker contains
		// assets." Advisory: if this call fails, has_assets stays unknown and the asset probe below decides.
		try {
			apiHasAssets = hasAssetsFromApi(undefined, await cfGet(`/accounts/${accountId}/workers/scripts`, token), expected.workerName);
		} catch (err) {
			console.log(`[verify-worker-placement] has_assets not read (${err instanceof Error ? err.message : String(err)}); relying on the static asset probe`);
		}
	}

	const placement = placementFromService(service);
	const result = evaluateWorker(expected, placement, settings?.bindings ?? [], { apiHasAssets });
	console.log(`[verify-worker-placement] worker=${expected.workerName} env=${env}`);
	console.log(
		`[verify-worker-placement] placement mode=${placement.mode ?? '-'} region=${placement.regions.join(',') || '-'} (expected ${expected.placementRegion ?? 'none'}); last_deployed_from=${placement.lastDeployedFrom ?? '-'}`,
	);
	console.log(`[verify-worker-placement] vars ${Object.entries(expected.plainText).map(([k, v]) => `${k}=${v}`).join(' ')} (expected from wrangler.jsonc)`);
	for (const n of result.notes) console.log(`[verify-worker-placement] ${n}`);
	for (const f of result.failures) console.error(`[verify-worker-placement] FAIL ${f}`);

	// Exit 2 ("could not verify") reasons; only used when nothing above or below is a real mismatch.
	const unverified = [];
	let assetOk = true;
	if (expected.hasAssets && !flag('--no-asset-probe')) {
		const assetPath = arg('--asset-path', DEFAULT_ASSET_PROBE_PATH);
		const origin = arg('--asset-origin', SITE_ORIGINS[env]);
		const inBuild = ['../dist/client', '../public'].some((dir) => existsSync(fileURLToPath(new URL(`${dir}${assetPath}`, import.meta.url))));
		if (!assetPath.startsWith('/') || !inBuild) {
			unverified.push(`static asset probe path ${assetPath} is not in web/dist/client or web/public; pass --asset-path with a file from the build output`);
		} else {
			// Each live probe retries (DEFAULT_PROBE_ATTEMPTS x DEFAULT_PROBE_DELAY_MS) before a 5xx / non-200 /
			// network error counts; the static asset gets a fresh ?ft-verify=<ms> cache-buster per attempt.
			const probes = [
				['static asset', `${origin}${assetPath}`, probeStaticAsset, () => withCacheBust(`${origin}${assetPath}`)],
				['unmatched route', `${origin}${DEFAULT_UNMATCHED_PROBE_PATH}`, probeUnmatchedRoute, () => `${origin}${DEFAULT_UNMATCHED_PROBE_PATH}`],
			];
			for (const [label, probeUrl, probe, makeUrl] of probes) {
				const result = await probeWithRetry({
					probe,
					makeUrl,
					label,
					log: (line) => console.log(`[verify-worker-placement] ${line}`),
				});
				const { outcome, message } = classifyAssetProbe(result);
				if (outcome === 'unverified') unverified.push(message);
				else if (outcome === 'mismatch') {
					assetOk = false;
					console.error(`[verify-worker-placement] FAIL ${message}`);
				} else {
					console.log(`[verify-worker-placement] ${label} ${redactUrl(probeUrl)}: ${message}`);
				}
			}
		}
	} else if (expected.hasAssets) {
		console.log('[verify-worker-placement] static asset probe skipped (--no-asset-probe)');
	}

	let timingOk = true;
	const url = arg('--url');
	if (url) {
		const samples = Number(arg('--samples', '5'));
		const cookieEnv = arg('--cookie-env');
		const headers = cookieEnv && process.env[cookieEnv] ? { cookie: process.env[cookieEnv] } : {};
		const sampled = await sampleServerTimings({ url, samples, headers });
		if ('error' in sampled) {
			// Network / DNS failure is "could not verify" (2), never "mismatch" (1); a mismatch found
			// elsewhere still wins. No headers or cookies are logged.
			unverified.push(sampled.error);
		} else {
			const s = summarizeDbTiming(sampled.timings, Number(arg('--max-ms-per-query', '60')));
			console.log(
				`[verify-worker-placement] Server-Timing ${redactUrl(url)}: warm samples with DB=${s.samples}, median ms/query=${s.medianMsPerQuery ?? '-'} — ${s.note}`,
			);
			timingOk = s.ok || !flag('--strict-timing');
		}
	}

	for (const u of unverified) console.error(`[verify-worker-placement] could not verify: ${u}`);
	const code = verifierExitCode({ mismatch: !result.ok || !assetOk || !timingOk, unverified });
	if (code === 0) console.log('[verify-worker-placement] OK');
	return code;
}

try {
	process.exitCode = await main();
} catch (err) {
	// Anything unexpected is "could not verify" (2); exit 1 is reserved for a real mismatch.
	console.error(`[verify-worker-placement] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 2;
}
