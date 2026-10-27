#!/usr/bin/env node
// Read-only check that the deployed Worker runs with the placement and plain_text vars that
// web/wrangler.jsonc declares (PAGE_CACHE, PAGE_CACHE_TTL_SECONDS, SITE_ACCESS_MODE), still has its
// assets binding, and was last deployed by Wrangler. Optionally samples Server-Timing DB time.
//
// Usage (from web/):
//   node scripts/verify-worker-placement.mjs --env staging|production [--url https://host/path] [--samples 5]
//        [--cookie-env FT_STAGING_COOKIE] [--max-ms-per-query 60] [--strict-timing] [--env-file ../.env.dev]
//
// Auth: the first plausible token (40+ chars, no whitespace, same rule as the deploy scripts) from
// CLOUDFLARE_API_TOKEN, TF_VAR_CLOUDFLARE_API_TOKEN, TF_VAR_cloudflare_api_token, then the same keys in
// --env-file (only those keys are read). A short process stub is skipped. The token and its length are
// never printed; only the source name is. Account id comes from CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc.
// Only GET requests are made.
//
// Exit codes: 0 OK, 1 mismatch, 2 usage / auth / API / network error.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
	evaluateWorker,
	expectedFromWrangler,
	parseEnvFileValues,
	parseJsonc,
	placementFromService,
	redactUrl,
	sampleServerTimings,
	selectCloudflareApiToken,
	summarizeDbTiming,
	TOKEN_ENV_FILE_KEYS,
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
	try {
		service = await cfGet(`/accounts/${accountId}/workers/services/${expected.workerName}`, token);
		settings = await cfGet(`/accounts/${accountId}/workers/scripts/${expected.workerName}/settings`, token);
	} catch (err) {
		console.error(`[verify-worker-placement] Cloudflare API error: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}

	const placement = placementFromService(service);
	const result = evaluateWorker(expected, placement, settings?.bindings ?? []);
	console.log(`[verify-worker-placement] worker=${expected.workerName} env=${env}`);
	console.log(
		`[verify-worker-placement] placement mode=${placement.mode ?? '-'} region=${placement.regions.join(',') || '-'} (expected ${expected.placementRegion ?? 'none'}); last_deployed_from=${placement.lastDeployedFrom ?? '-'}`,
	);
	console.log(`[verify-worker-placement] vars ${Object.entries(expected.plainText).map(([k, v]) => `${k}=${v}`).join(' ')} (expected from wrangler.jsonc)`);
	for (const n of result.notes) console.log(`[verify-worker-placement] ${n}`);
	for (const f of result.failures) console.error(`[verify-worker-placement] FAIL ${f}`);

	let timingOk = true;
	const url = arg('--url');
	if (url) {
		const samples = Number(arg('--samples', '5'));
		const cookieEnv = arg('--cookie-env');
		const headers = cookieEnv && process.env[cookieEnv] ? { cookie: process.env[cookieEnv] } : {};
		const sampled = await sampleServerTimings({ url, samples, headers });
		if ('error' in sampled) {
			// Network / DNS failure is "could not verify" (2), never "mismatch" (1); an API mismatch found
			// above still wins. No headers or cookies are logged.
			console.error(`[verify-worker-placement] ${sampled.error}`);
			return result.ok ? 2 : 1;
		}
		const timings = sampled.timings;
		const s = summarizeDbTiming(timings, Number(arg('--max-ms-per-query', '60')));
		console.log(
			`[verify-worker-placement] Server-Timing ${redactUrl(url)}: warm samples with DB=${s.samples}, median ms/query=${s.medianMsPerQuery ?? '-'} — ${s.note}`,
		);
		timingOk = s.ok || !flag('--strict-timing');
	}

	if (!result.ok || !timingOk) return 1;
	console.log('[verify-worker-placement] OK');
	return 0;
}

try {
	process.exitCode = await main();
} catch (err) {
	// Anything unexpected is "could not verify" (2); exit 1 is reserved for a real mismatch.
	console.error(`[verify-worker-placement] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 2;
}
