#!/usr/bin/env node
// Read-only check that the deployed Worker runs with the placement and plain_text vars that
// web/wrangler.jsonc declares (PAGE_CACHE, PAGE_CACHE_TTL_SECONDS, SITE_ACCESS_MODE), still has its
// assets binding, and was last deployed by Wrangler. Optionally samples Server-Timing DB time.
//
// Usage (from web/):
//   node scripts/verify-worker-placement.mjs --env staging|production [--url https://host/path] [--samples 5]
//        [--cookie-env FT_STAGING_COOKIE] [--max-ms-per-query 60] [--strict-timing] [--env-file ../.env.dev]
//
// Auth: CLOUDFLARE_API_TOKEN (or TF_VAR_CLOUDFLARE_API_TOKEN) from the environment, or read from
// --env-file (only those two keys are read). The token is never printed. Account id comes from
// CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc. Only GET requests are made.
//
// Exit codes: 0 OK, 1 mismatch, 2 usage / auth / API error.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateWorker, expectedFromWrangler, parseJsonc, parseServerTiming, placementFromService, summarizeDbTiming } from './lib/worker-placement-check.mjs';

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);

function readTokenFromEnvFile(path) {
	try {
		for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
			const m = /^\s*(?:export\s+)?(CLOUDFLARE_API_TOKEN|TF_VAR_CLOUDFLARE_API_TOKEN)\s*=\s*(.*)\s*$/.exec(line);
			if (m && m[2]) return m[2].replace(/^['"]|['"]$/g, '');
		}
	} catch {
		console.error(`[verify-worker-placement] cannot read --env-file ${path}`);
	}
	return undefined;
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
	const token =
		process.env.CLOUDFLARE_API_TOKEN || process.env.TF_VAR_CLOUDFLARE_API_TOKEN || (envFile ? readTokenFromEnvFile(envFile) : undefined);
	if (!token || !accountId) {
		console.error('[verify-worker-placement] set CLOUDFLARE_API_TOKEN (or TF_VAR_CLOUDFLARE_API_TOKEN / --env-file) and CLOUDFLARE_ACCOUNT_ID.');
		return 2;
	}

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
		const timings = [];
		for (let i = 0; i < samples; i += 1) {
			const res = await fetch(url, { headers, redirect: 'manual' });
			await res.arrayBuffer();
			if (i === 0) continue; // first request may be cold (isolate start, connection setup)
			timings.push(parseServerTiming(res.headers.get('server-timing')));
		}
		const s = summarizeDbTiming(timings, Number(arg('--max-ms-per-query', '60')));
		console.log(
			`[verify-worker-placement] Server-Timing ${url}: warm samples with DB=${s.samples}, median ms/query=${s.medianMsPerQuery ?? '-'} — ${s.note}`,
		);
		timingOk = s.ok || !flag('--strict-timing');
	}

	if (!result.ok || !timingOk) return 1;
	console.log('[verify-worker-placement] OK');
	return 0;
}

process.exitCode = await main();
