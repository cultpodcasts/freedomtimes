/**
 * PR #198: Analytics Engine rejects an index over 96 bytes, so long `/posts/{slug}` paths
 * were silently dropped from /admin/analytics. Synthetic paths only (no real data).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	ANALYTICS_ENGINE_INDEX_MAX_BYTES,
	buildPageViewDataPoint,
	createOnceErrorReporter,
	fnv1a64Hex,
	PAGE_VIEW_INDEX_LENGTH,
	pageViewIndexKey,
} from '../src/lib/page-view-index.ts';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const bytes = (value: string) => new TextEncoder().encode(value).length;

const SAM_CARLING =
	'/posts/sam-carling-satvir-kaur-family-survival-trust-uk-cults-aropl-ivdivo-zizians-cult-news-22-november-2026';
const KATIE_SIMPSON =
	'/posts/building-the-cult-what-katie-simpsons-murder-reveals-about-coercive-control-group-dynamics-and-the-laws-that-should-have-saved-her';

/** Mirrors Cloudflare's runtime check: `writeDataPoint(): Size of indexes[0] exceeds 96 bytes).` */
function assertAcceptedByAnalyticsEngine(point: { blobs: string[]; indexes: string[] }) {
	assert.equal(point.indexes.length, 1);
	assert.ok(
		bytes(point.indexes[0]!) <= ANALYTICS_ENGINE_INDEX_MAX_BYTES,
		`index is ${bytes(point.indexes[0]!)} bytes`,
	);
	assert.ok(point.blobs.reduce((n, b) => n + bytes(b), 0) <= 16 * 1024);
}

describe('page-view Analytics Engine data point', () => {
	it('the real-world long paths are over the 96-byte index limit', () => {
		assert.equal(bytes(SAM_CARLING), 109);
		assert.equal(bytes(KATIE_SIMPSON), 137);
	});

	for (const [name, path] of [
		['109-byte sam-carling path', SAM_CARLING],
		['137-byte Katie Simpson path', KATIE_SIMPSON],
		['short path', '/posts/weekly-summary-1-november-2026'],
		['homepage', '/'],
		['256-byte multibyte path', `/posts/${'é'.repeat(124)}`],
	] as const) {
		it(`${name}: full path in blob1, fixed-length index under 96 bytes`, () => {
			const point = buildPageViewDataPoint(path, 'GB', false);
			assert.deepEqual(point.blobs, [path, 'GB', '0']);
			assert.deepEqual(point.doubles, [1]);
			assert.equal(point.indexes[0], pageViewIndexKey(path));
			assert.equal(point.indexes[0]!.length, PAGE_VIEW_INDEX_LENGTH);
			assert.match(point.indexes[0]!, /^p1:[0-9a-f]{16}$/);
			assertAcceptedByAnalyticsEngine(point);
		});
	}

	it('bot flag goes in blob3', () => {
		assert.equal(buildPageViewDataPoint('/', 'XX', true).blobs[2], '1');
	});

	it('index is deterministic and distinct per path', () => {
		assert.equal(pageViewIndexKey(SAM_CARLING), pageViewIndexKey(SAM_CARLING));
		assert.notEqual(pageViewIndexKey(SAM_CARLING), pageViewIndexKey(KATIE_SIMPSON));
		assert.notEqual(pageViewIndexKey('/a'), pageViewIndexKey('/b'));
	});

	it('FNV-1a 64 matches known vectors', () => {
		assert.equal(fnv1a64Hex(''), 'cbf29ce484222325');
		assert.equal(fnv1a64Hex('a'), 'af63dc4c8601ec8c');
		assert.equal(fnv1a64Hex('foobar'), '85944171f73967e8');
	});
});

describe('page-view write failure reporting', () => {
	it('logs once per distinct error, as an error', () => {
		const logged: { message: string; details: Record<string, unknown> }[] = [];
		const report = createOnceErrorReporter((message, details) => logged.push({ message, details }));
		const err = new Error('writeDataPoint(): Size of indexes[0] exceeds 96 bytes).');
		assert.equal(report(err, { path: SAM_CARLING }), true);
		assert.equal(report(err, { path: SAM_CARLING }), false);
		assert.equal(report(new Error('other')), true);
		assert.equal(logged.length, 2);
		assert.match(logged[0]!.message, /NOT being recorded/);
		assert.equal(logged[0]!.details.message, err.message);
		assert.equal(logged[0]!.details.path, SAM_CARLING);
	});
});

describe('recordPageView wiring (source check; module imports cloudflare:workers)', () => {
	const src = read('../src/lib/page-view-analytics.ts');

	it('writes the shared data point builder, never the raw path as index', () => {
		assert.match(src, /dataset\.writeDataPoint\(buildPageViewDataPoint\(path, country, isBot\)\)/);
		assert.doesNotMatch(src, /indexes:\s*\[path\]/);
	});

	it('reports failures through the once-only error reporter, not console.warn', () => {
		assert.match(src, /reportPageViewWriteFailure\(error/);
		assert.doesNotMatch(src, /console\.warn\('\[page-view-analytics\] write failed'/);
	});

	it('admin queries still read blob1 (full path), not index1', () => {
		assert.match(src, /blob1 AS key/);
		assert.doesNotMatch(src, /(SELECT|WHERE|AND|GROUP BY)[^\n]*index1/);
	});
});
