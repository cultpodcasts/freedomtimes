// Pure helpers for scripts/verify-worker-placement.mjs (no network, no fs) so they can be unit-tested.
//
// Why not the `cf-placement` response header: Cloudflare documents that "the cf-placement header may be
// removed" (https://developers.cloudflare.com/workers/configuration/placement/#cf-placement-header) and it
// is not emitted for our Worker. The authoritative check is the Workers API
// (GET /accounts/{account}/workers/services/{worker} — "Check placement status" in the same doc), plus the
// script settings (GET /accounts/{account}/workers/scripts/{worker}/settings) for bindings.
//
// Static assets: an `assets` binding is OPTIONAL. Cloudflare only lists one in the script settings bindings
// when wrangler.jsonc sets `assets.binding` ("Configuring the optional binding gives you access to the
// collection of assets from within your Worker script",
// https://developers.cloudflare.com/workers/static-assets/binding/#binding; the Direct Upload API adds
// `{ name, type: "assets" }` to `bindings` only "if you wish to fetch and serve assets from within your
// Worker code", https://developers.cloudflare.com/workers/static-assets/direct-upload/). Our wrangler.jsonc
// names the binding ASSETS (required by the @astrojs/cloudflare entry, see the comment there); a config
// without a binding name would expect none. Whether a Worker has
// assets at all is the documented `has_assets` boolean on the script object ("Whether a Worker contains
// assets", GET /accounts/{account}/workers/scripts,
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/). The settings
// endpoint has no assets config field. The end-to-end proof is a logged-out GET of a static file that is in
// the build output (probeStaticAsset): assets are served before the Worker runs, so it bypasses the staging
// login wall; a missing asset falls through to the Worker (302 to the login wall / HTML 404). A second probe
// (probeUnmatchedRoute) catches an unbound env.ASSETS at runtime: unmatched routes then 500.

/** Strip // and /* *\/ comments and trailing commas from JSONC, respecting strings. */
export function parseJsonc(text) {
	let out = '';
	let i = 0;
	let inString = false;
	while (i < text.length) {
		const c = text[i];
		const n = text[i + 1];
		if (inString) {
			out += c;
			if (c === '\\') {
				out += n ?? '';
				i += 2;
				continue;
			}
			if (c === '"') inString = false;
			i += 1;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i += 1;
			continue;
		}
		if (c === '/' && n === '/') {
			while (i < text.length && text[i] !== '\n') i += 1;
			continue;
		}
		if (c === '/' && n === '*') {
			i += 2;
			while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
			i += 2;
			continue;
		}
		out += c;
		i += 1;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Expected Worker settings for one environment, from wrangler.jsonc.
 * @returns {{ workerName: string, accountId: string|undefined, placementRegion: string|undefined, plainText: Record<string,string>, hasAssets: boolean, assetsBinding: string|undefined }}
 */
export function expectedFromWrangler(wrangler, env) {
	const e = wrangler.env?.[env];
	if (!e) throw new Error(`wrangler.jsonc has no env.${env}`);
	const vars = e.vars ?? {};
	const plainText = {};
	for (const key of ['PAGE_CACHE', 'PAGE_CACHE_TTL_SECONDS', 'SITE_ACCESS_MODE']) {
		if (typeof vars[key] === 'string') plainText[key] = vars[key];
	}
	return {
		workerName: e.name ?? wrangler.name,
		accountId: wrangler.account_id,
		placementRegion: (e.placement ?? wrangler.placement)?.region,
		plainText,
		hasAssets: Boolean(e.assets ?? wrangler.assets),
		// Only set when wrangler.jsonc names a binding; then Cloudflare lists it with type "assets".
		assetsBinding: typeof (e.assets ?? wrangler.assets)?.binding === 'string' ? (e.assets ?? wrangler.assets).binding : undefined,
	};
}

const FAILED_PLACEMENT_STATUSES = new Set(['UNSUPPORTED_APPLICATION', 'INSUFFICIENT_INVOCATIONS', 'NO_VALID_HOSTS', 'NO_VALID_HOSTNAMES', 'UNSUPPORTED_HOST']);

/** The script object of a GET /workers/services/{name} result (shape varies by API version). */
export function scriptFromService(serviceResult) {
	return serviceResult?.default_environment?.script ?? serviceResult?.script ?? serviceResult ?? {};
}

/** Extract placement from GET /workers/services/{name} result (shape varies by API version). */
export function placementFromService(serviceResult) {
	const script = scriptFromService(serviceResult);
	const placement = script.placement ?? {};
	const targets = Array.isArray(placement.target) ? placement.target : [];
	const regions = targets
		.map((t) => (typeof t === 'object' && t ? t.region : undefined))
		.filter((r) => typeof r === 'string');
	if (typeof placement.region === 'string') regions.push(placement.region);
	return {
		mode: placement.mode ?? script.placement_mode,
		regions,
		status: placement.status ?? script.placement_status,
		lastDeployedFrom: script.last_deployed_from,
	};
}

/**
 * `has_assets` for the Worker from the API: the services result's script object first, then the
 * GET /workers/scripts list entry whose `id` is the Worker name. undefined = not reported.
 * @returns {boolean|undefined}
 */
export function hasAssetsFromApi(serviceResult, scriptList, workerName) {
	const script = scriptFromService(serviceResult);
	if (typeof script.has_assets === 'boolean') return script.has_assets;
	const entry = Array.isArray(scriptList) ? scriptList.find((s) => s && (s.id === workerName || s.script_name === workerName)) : undefined;
	return typeof entry?.has_assets === 'boolean' ? entry.has_assets : undefined;
}

/**
 * Compare live Worker state to wrangler.jsonc.
 * @param {ReturnType<typeof expectedFromWrangler>} expected
 * @param {ReturnType<typeof placementFromService>} placement
 * @param {Array<{name: string, type: string, text?: string}>} bindings from script settings
 * @param {{ apiHasAssets?: boolean }} [assets] `has_assets` from hasAssetsFromApi (undefined = not reported)
 */
export function evaluateWorker(expected, placement, bindings, { apiHasAssets } = {}) {
	const failures = [];
	const notes = [];

	if (expected.placementRegion) {
		if (placement.mode !== 'targeted') {
			failures.push(`placement mode is ${JSON.stringify(placement.mode ?? null)}, expected "targeted" (region ${expected.placementRegion})`);
		}
		if (!placement.regions.includes(expected.placementRegion)) {
			failures.push(`placement region is ${JSON.stringify(placement.regions)}, expected ${expected.placementRegion}`);
		}
	}
	if (placement.status && FAILED_PLACEMENT_STATUSES.has(placement.status)) {
		failures.push(`placement status ${placement.status}`);
	} else {
		notes.push(`placement status ${placement.status ?? '(not present)'}`);
	}

	const byName = new Map((bindings ?? []).map((b) => [b.name, b]));
	for (const [name, value] of Object.entries(expected.plainText)) {
		const b = byName.get(name);
		if (!b) failures.push(`binding ${name} is missing (wrangler.jsonc sets "${value}")`);
		else if (b.type !== 'plain_text') failures.push(`binding ${name} has type ${b.type}, expected plain_text`);
		else if (b.text !== value) failures.push(`binding ${name}="${b.text}", wrangler.jsonc sets "${value}"`);
	}
	if (expected.assetsBinding) {
		const b = byName.get(expected.assetsBinding);
		if (!b) failures.push(`assets binding ${expected.assetsBinding} is missing (wrangler.jsonc assets.binding)`);
		else if (b.type !== 'assets') failures.push(`binding ${expected.assetsBinding} has type ${b.type}, expected assets`);
	} else if (expected.hasAssets) {
		notes.push('assets configured without a binding name in wrangler.jsonc: no assets binding expected');
	}
	if (expected.hasAssets) {
		if (apiHasAssets === false) failures.push('Cloudflare reports has_assets=false: the Worker has no static assets (they would fall through to the Worker)');
		else notes.push(`has_assets ${apiHasAssets === true ? 'true' : '(not reported by the API)'}`);
	}
	if (placement.lastDeployedFrom && placement.lastDeployedFrom !== 'wrangler') {
		failures.push(
			`last_deployed_from is "${placement.lastDeployedFrom}", not "wrangler": a non-Wrangler upload (e.g. terraform apply) replaced the bundle settings. Redeploy the Worker with Wrangler.`,
		);
	}
	return { ok: failures.length === 0, failures, notes };
}

// --- Static asset probe ---------------------------------------------------------------------------

/** Each environment's own public origin (= infra/terraform/environments/<env> variable workspace_url). */
export const SITE_ORIGINS = Object.freeze({
	staging: 'https://staging.freedomtimes.news',
	production: 'https://freedomtimes.news',
});

/** Default probe path: web/public/favicon.svg, copied to dist/client by astro build (asserted by a unit test). */
export const DEFAULT_ASSET_PROBE_PATH = '/favicon.svg';

/** Query parameter that makes each static-asset probe URL unique, so an edge-cached copy cannot answer it. */
export const ASSET_PROBE_CACHE_BUST_PARAM = 'ft-verify';

/** `<url>?ft-verify=<now>` (or `&ft-verify=` when the URL already has a query). redactUrl drops it from logs. */
export function withCacheBust(url, now = Date.now()) {
	const u = new URL(url);
	u.searchParams.set(ASSET_PROBE_CACHE_BUST_PARAM, String(now));
	return u.href;
}

/**
 * Logged-out GET of one static asset (no cookies, redirects not followed). Static assets are served before
 * the Worker runs, so this bypasses the staging login wall. Pass: HTTP 200 and a non-HTML content-type.
 * A missing asset falls through to the Worker: 302 to the login wall (staging) or an HTML 404 (production).
 * Callers pass a cache-busted URL (withCacheBust) so a cached copy from before the deploy cannot pass it;
 * `cf-cache-status` is returned for the log. Network / DNS errors return `{ error }` (exit 2 "could not
 * verify"), never a mismatch.
 * @param {{ url: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ ok: boolean, status: number, contentType: string, cfCacheStatus?: string, failure?: string } | { error: string }>}
 */
export async function probeStaticAsset({ url, fetchImpl = fetch }) {
	let res;
	try {
		res = await fetchImpl(url, { redirect: 'manual' });
		await res.arrayBuffer();
	} catch (err) {
		return { error: `static asset probe of ${redactUrl(url)} failed: ${describeNetworkError(err)}` };
	}
	const contentType = res.headers.get('content-type') ?? '';
	const cfCacheStatus = res.headers.get('cf-cache-status') ?? undefined;
	let failure;
	if (res.status !== 200) {
		const location = res.headers.get('location');
		failure = `static asset ${redactUrl(url)} returned HTTP ${res.status}${location ? ` (location ${redactUrl(new URL(location, url).href)})` : ''}, expected 200 from the assets layer`;
	} else if (/^\s*text\/html\b/i.test(contentType) || contentType.trim() === '') {
		failure = `static asset ${redactUrl(url)} returned content-type ${JSON.stringify(contentType)}, expected a non-HTML asset type (the Worker answered, not the assets layer)`;
	}
	return failure
		? { ok: false, status: res.status, contentType, cfCacheStatus, failure }
		: { ok: true, status: res.status, contentType, cfCacheStatus };
}

/**
 * Map a probeStaticAsset result to the verifier outcome: ok, mismatch (exit 1) or unverified (exit 2).
 * @returns {{ outcome: 'ok'|'mismatch'|'unverified', message: string }}
 */
export function classifyAssetProbe(probe) {
	if ('error' in probe) return { outcome: 'unverified', message: probe.error };
	if (!probe.ok) return { outcome: 'mismatch', message: probe.failure ?? `probe failed (HTTP ${probe.status})` };
	const cache = probe.cfCacheStatus ? `, cf-cache-status ${probe.cfCacheStatus}` : '';
	return { outcome: 'ok', message: `HTTP ${probe.status} ${probe.contentType || '(no content-type)'} (logged out${cache})` };
}

/** Live probes retry this many times, this far apart, before a 5xx / non-200 / network error counts. */
export const DEFAULT_PROBE_ATTEMPTS = 4;
export const DEFAULT_PROBE_DELAY_MS = 5000;

/**
 * Run a live probe (probeStaticAsset / probeUnmatchedRoute) up to `attempts` times, `delayMs` apart, so a
 * single transient edge 5xx or a just-deployed version that is still propagating does not fail a deploy.
 * Stops at the first ok attempt. Returns the result to classify (classifyAssetProbe):
 * - any attempt ok → that ok result;
 * - otherwise, if any attempt got an HTTP response → the last HTTP failure (mismatch, exit 1);
 * - every attempt was a network error → the last `{ error }` (could not verify, exit 2).
 * `makeUrl(attempt)` builds each attempt's URL (fresh cache-buster per attempt). `log` gets one line per
 * attempt with the status only (no headers, no cookies, query stripped by redactUrl).
 * @param {{ probe: (o: { url: string, fetchImpl?: typeof fetch }) => Promise<any>, makeUrl: (attempt: number) => string,
 *   attempts?: number, delayMs?: number, sleep?: (ms: number) => Promise<void>, fetchImpl?: typeof fetch,
 *   log?: (line: string) => void, label?: string }} opts
 */
export async function probeWithRetry({
	probe,
	makeUrl,
	attempts = DEFAULT_PROBE_ATTEMPTS,
	delayMs = DEFAULT_PROBE_DELAY_MS,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
	fetchImpl,
	log = () => {},
	label = 'probe',
}) {
	const total = Math.max(1, Math.floor(attempts));
	let lastHttpFailure;
	let lastError;
	for (let attempt = 1; attempt <= total; attempt++) {
		const url = makeUrl(attempt);
		const result = await probe(fetchImpl ? { url, fetchImpl } : { url });
		if ('error' in result) {
			lastError = result;
			log(`${label} attempt ${attempt}/${total}: network error`);
		} else {
			log(`${label} attempt ${attempt}/${total}: HTTP ${result.status}${result.ok ? '' : ' (not ok)'}`);
			if (result.ok) return { ...result, attempts: attempt };
			lastHttpFailure = result;
		}
		if (attempt < total) await sleep(delayMs);
	}
	if (lastHttpFailure) {
		return { ...lastHttpFailure, failure: `${lastHttpFailure.failure} (after ${total} attempts)`, attempts: total };
	}
	return { error: `${lastError.error} (after ${total} attempts)` };
}

/** Verifier exit code: 1 if any real mismatch, else 2 if anything could not be checked, else 0. */
export function verifierExitCode({ mismatch, unverified }) {
	if (mismatch) return 1;
	return unverified.length > 0 ? 2 : 0;
}

/**
 * A path no page or asset matches. A public site must answer it with the not-found page (HTTP 404,
 * src/pages/404.astro since #119); the locked staging site answers a logged-out request with a redirect
 * to sign-in before any route runs.
 */
export const DEFAULT_UNMATCHED_PROBE_PATH = '/__ft-verify/no-such-route/a/b';

/** Redirect statuses the locked (SITE_ACCESS_MODE=locked) login wall may answer a logged-out request with. */
export const LOCKED_SITE_REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);

/**
 * What the unmatched-route probe must see for a given SITE_ACCESS_MODE (from wrangler.jsonc):
 * "locked" → a redirect with a Location (the login wall); anything else (public) → exactly 404.
 * @param {string | undefined} siteAccessMode
 * @returns {{ mode: 'locked' | 'public', describe: string }}
 */
export function unmatchedRouteExpectation(siteAccessMode) {
	return siteAccessMode === 'locked'
		? { mode: 'locked', describe: 'a 3xx redirect to sign-in (SITE_ACCESS_MODE=locked)' }
		: { mode: 'public', describe: 'HTTP 404 (the not-found page)' };
}

/**
 * Logged-out GET of a URL no route matches (redirects not followed). Pass: exactly HTTP 404 on a public
 * site (#122; every unmatched URL renders src/pages/404.astro since #119, so a 400 "Missing slug" or a 200
 * is a regression), or a 3xx with a Location on the locked staging site (login wall). Anything else fails,
 * with the cause named where it is known:
 * - 503: the content store is unavailable (#128 / #160: unmigrated, empty or unreachable EmDash database,
 *   or EmDash migrations pending) — a deploy against a broken store must not pass;
 * - other 5xx: a 500 here usually means env.ASSETS is unbound (the @astrojs/cloudflare entry sends
 *   unmatched routes to env.ASSETS.fetch() before rendering the 404).
 * @param {{ url: string, fetchImpl?: typeof fetch, siteAccessMode?: string }} opts
 * @returns {Promise<{ ok: boolean, status: number, contentType: string, failure?: string } | { error: string }>}
 */
export async function probeUnmatchedRoute({ url, fetchImpl = fetch, siteAccessMode }) {
	let res;
	try {
		res = await fetchImpl(url, { redirect: 'manual' });
		await res.arrayBuffer();
	} catch (err) {
		return { error: `unmatched-route probe of ${redactUrl(url)} failed: ${describeNetworkError(err)}` };
	}
	const contentType = res.headers.get('content-type') ?? '';
	const expectation = unmatchedRouteExpectation(siteAccessMode);
	const location = res.headers.get('location');
	const ok =
		expectation.mode === 'locked'
			? LOCKED_SITE_REDIRECT_STATUSES.includes(res.status) && Boolean(location)
			: res.status === 404;
	if (ok) return { ok: true, status: res.status, contentType };
	let where = '';
	if (location) {
		try {
			where = ` (location ${redactUrl(new URL(location, url).href)})`;
		} catch {
			where = ' (unparseable location)';
		}
	}
	let cause = '';
	if (res.status === 503) {
		const retryAfter = res.headers.get('retry-after');
		cause = `: the content store is unavailable${retryAfter ? ` (Retry-After ${retryAfter})` : ''} — the Worker's EmDash database is unmigrated, empty or unreachable, or migrations are pending (#128 / #160); fix the database binding before trusting this deploy`;
	} else if (res.status >= 500) {
		cause = ' (a 500 here usually means env.ASSETS is unbound)';
	} else if (expectation.mode === 'public' && res.status === 400) {
		cause = ' (a 400 "Missing slug" means the not-found page from #119 is no longer reached)';
	} else if (expectation.mode === 'locked' && res.status === 404) {
		cause = ' (a logged-out 404 means the login wall did not run)';
	}
	return {
		ok: false,
		status: res.status,
		contentType,
		failure: `unmatched route ${redactUrl(url)} returned HTTP ${res.status}${where}, expected ${expectation.describe}${cause}`,
	};
}

/** Parse a Server-Timing header into { name: durMs }. */
export function parseServerTiming(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(',')) {
		const [rawName, ...params] = part.trim().split(';');
		const name = rawName?.trim();
		if (!name) continue;
		let dur;
		for (const p of params) {
			const m = /^\s*dur\s*=\s*"?([0-9.]+)"?\s*$/.exec(p);
			if (m) dur = Number(m[1]);
		}
		out[name] = dur ?? 0;
	}
	return out;
}

/**
 * Sanity check of DB time per query on warm samples. Placed next to the Turso primary each libsql
 * round trip is a few ms (Cloudflare: "Reducing round-trip latency from 20 to 30 milliseconds per query
 * to 1 to 3 milliseconds"); unplaced from a US colo it was ~90 ms per trip (2026-10-27 baseline).
 * Advisory only: the API check above is authoritative.
 */
export function summarizeDbTiming(samples, maxMsPerQuery = 60) {
	const perQuery = samples
		.map((st) => (st['db.count'] > 0 ? st['db.total'] / st['db.count'] : undefined))
		.filter((v) => typeof v === 'number' && Number.isFinite(v))
		.sort((a, b) => a - b);
	if (perQuery.length === 0) return { ok: true, medianMsPerQuery: undefined, samples: 0, note: 'no samples with db.count > 0' };
	const median = perQuery[Math.floor(perQuery.length / 2)];
	return {
		ok: median <= maxMsPerQuery,
		medianMsPerQuery: Math.round(median * 10) / 10,
		samples: perQuery.length,
		note: median <= maxMsPerQuery ? 'consistent with placement near the DB' : `median ${median.toFixed(1)} ms/query > ${maxMsPerQuery} ms: Worker may not be running near the DB`,
	};
}

// --- Credentials ----------------------------------------------------------------------------------

/**
 * Same rule as Test-DeployCloudflareApiTokenPlausible (scripts/Deploy-EnvironmentCommon.ps1): real
 * Cloudflare API tokens are 40+ characters with no whitespace. Cursor Cloud injects a ~31-character
 * CLOUDFLARE_API_TOKEN stub that would otherwise shadow the real TF_VAR token (HTTP 401 / 6111 / 9106).
 */
export function isPlausibleCloudflareApiToken(token) {
	if (typeof token !== 'string') return false;
	const t = token.trim();
	return t.length >= 40 && !/\s/.test(t);
}

/** Process-env names tried in order. terraform-run.ps1 remaps to the lowercase TF_VAR name (case-sensitive on Linux/WSL). */
export const TOKEN_ENV_NAMES = ['CLOUDFLARE_API_TOKEN', 'TF_VAR_CLOUDFLARE_API_TOKEN', 'TF_VAR_cloudflare_api_token'];
/** Keys read from --env-file, in order (only these keys are read). */
export const TOKEN_ENV_FILE_KEYS = ['CLOUDFLARE_API_TOKEN', 'TF_VAR_CLOUDFLARE_API_TOKEN', 'TF_VAR_cloudflare_api_token'];

/**
 * Parse only `keys` from .env text. Same base rules as scripts/lib/EnvFile.ps1 (#113): blank and `#`
 * lines skipped, KEY=VALUE with KEY [A-Za-z_][A-Za-z0-9_]*, key/value trimmed incl. BOM, first
 * non-empty occurrence wins. Additionally tolerated here (never part of a token): an `export ` prefix,
 * one pair of matching surrounding quotes, and an unquoted inline comment (`<whitespace>#...`).
 * @returns {Record<string, string>}
 */
export function parseEnvFileValues(text, keys) {
	const wanted = new Set(keys);
	const out = {};
	for (const raw of String(text ?? '').split(/\r?\n/)) {
		const line = raw.replace(/^\uFEFF/, '').trim();
		if (!line || line.startsWith('#')) continue;
		const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (!m || !wanted.has(m[1]) || m[1] in out) continue;
		let value = m[2].replace(/\uFEFF/g, '').trim();
		const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/.exec(value);
		if (quoted) value = quoted[2];
		else value = value.replace(/\s+#.*$/, '').trim();
		if (value) out[m[1]] = value;
	}
	return out;
}

/**
 * Pick the first plausible token: process env (TOKEN_ENV_NAMES), then env-file values. Never returns
 * or logs anything about rejected values except their source name.
 * @param {Record<string, string|undefined>} env
 * @param {Record<string, string>} [envFileValues]
 * @returns {{ token: string|undefined, source: string|undefined, skipped: string[] }}
 */
export function selectCloudflareApiToken(env, envFileValues = {}) {
	const candidates = [
		...TOKEN_ENV_NAMES.map((n) => ({ source: `env ${n}`, value: env?.[n] })),
		...TOKEN_ENV_FILE_KEYS.map((n) => ({ source: `--env-file ${n}`, value: envFileValues?.[n] })),
	];
	const skipped = [];
	for (const c of candidates) {
		if (typeof c.value !== 'string' || c.value.trim() === '') continue;
		if (isPlausibleCloudflareApiToken(c.value)) return { token: c.value.trim(), source: c.source, skipped };
		skipped.push(c.source);
	}
	return { token: undefined, source: undefined, skipped };
}

/** URL safe to log: origin + path only (no query string, which could carry a token). */
export function redactUrl(url) {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname}`;
	} catch {
		return '(invalid URL)';
	}
}

/** Short reason for a fetch() failure (never includes request headers or cookies). */
export function describeNetworkError(err) {
	const cause = err && typeof err === 'object' && 'cause' in err ? err.cause : undefined;
	const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined;
	const msg = err instanceof Error ? err.message : String(err);
	return code ? `${msg} (${code})` : msg;
}

/**
 * Fetch `url` `samples` times and parse Server-Timing on the warm ones (the first, possibly cold,
 * request is discarded). Network / DNS errors are returned as `{ error }` so the caller exits 2
 * ("could not verify"), never 1 ("mismatch").
 * @param {{ url: string, samples: number, headers?: Record<string,string>, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ timings: Record<string, number>[] } | { error: string }>}
 */
export async function sampleServerTimings({ url, samples, headers = {}, fetchImpl = fetch }) {
	const timings = [];
	try {
		for (let i = 0; i < samples; i += 1) {
			const res = await fetchImpl(url, { headers, redirect: 'manual' });
			await res.arrayBuffer();
			if (i === 0) continue;
			timings.push(parseServerTiming(res.headers.get('server-timing')));
		}
	} catch (err) {
		return { error: `Server-Timing sampling of ${redactUrl(url)} failed: ${describeNetworkError(err)}` };
	}
	return { timings };
}
