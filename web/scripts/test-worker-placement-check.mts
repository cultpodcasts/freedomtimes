import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	evaluateWorker,
	expectedFromWrangler,
	parseJsonc,
	parseServerTiming,
	placementFromService,
	summarizeDbTiming,
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

	it('fails when assets binding is gone or a non-Wrangler upload was last', () => {
		const noAssets = bindings('off').filter((b) => b.type !== 'assets');
		assert.match(evaluateWorker(staging, placementFromService(service(PLACED)), noAssets).failures.join('\n'), /no assets binding/);
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
