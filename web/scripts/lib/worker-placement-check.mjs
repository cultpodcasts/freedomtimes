// Pure helpers for scripts/verify-worker-placement.mjs (no network, no fs) so they can be unit-tested.
//
// Why not the `cf-placement` response header: Cloudflare documents that "the cf-placement header may be
// removed" (https://developers.cloudflare.com/workers/configuration/placement/#cf-placement-header) and it
// is not emitted for our Worker. The authoritative check is the Workers API
// (GET /accounts/{account}/workers/services/{worker} — "Check placement status" in the same doc), plus the
// script settings (GET /accounts/{account}/workers/scripts/{worker}/settings) for bindings.

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
 * @returns {{ workerName: string, accountId: string|undefined, placementRegion: string|undefined, plainText: Record<string,string>, hasAssets: boolean }}
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
		hasAssets: Boolean(wrangler.assets ?? e.assets),
	};
}

const FAILED_PLACEMENT_STATUSES = new Set(['UNSUPPORTED_APPLICATION', 'INSUFFICIENT_INVOCATIONS', 'NO_VALID_HOSTS', 'NO_VALID_HOSTNAMES', 'UNSUPPORTED_HOST']);

/** Extract placement from GET /workers/services/{name} result (shape varies by API version). */
export function placementFromService(serviceResult) {
	const script = serviceResult?.default_environment?.script ?? serviceResult?.script ?? serviceResult ?? {};
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
 * Compare live Worker state to wrangler.jsonc.
 * @param {ReturnType<typeof expectedFromWrangler>} expected
 * @param {ReturnType<typeof placementFromService>} placement
 * @param {Array<{name: string, type: string, text?: string}>} bindings from script settings
 */
export function evaluateWorker(expected, placement, bindings) {
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
	if (expected.hasAssets && ![...byName.values()].some((b) => b.type === 'assets')) {
		failures.push('no assets binding (static assets would 404)');
	}
	if (placement.lastDeployedFrom && placement.lastDeployedFrom !== 'wrangler') {
		failures.push(
			`last_deployed_from is "${placement.lastDeployedFrom}", not "wrangler": a non-Wrangler upload (e.g. terraform apply) replaced the bundle settings. Redeploy the Worker with Wrangler.`,
		);
	}
	return { ok: failures.length === 0, failures, notes };
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
