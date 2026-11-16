/**
 * #195: render-path lookups are capped and slow ones are logged, so a stalled external call cannot
 * hold an article render for ~20 s again without showing up in Workers Logs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	RENDER_LOOKUP_SLOW_MS,
	RENDER_LOOKUP_TIMEOUT_LOG,
	RENDER_LOOKUP_TIMEOUT_MS,
	RENDER_SLOW_LOOKUP_LOG,
	RenderLookupSkippedError,
	RenderLookupTimeoutError,
	createRenderLookupBudget,
	isRenderLookupBoundError,
	timedRenderLookup,
} from '../src/lib/content/renderLookup.ts';

function recorder() {
	const lines: unknown[][] = [];
	return { lines, log: { warn: (...args: unknown[]) => lines.push(args) } };
}

describe('timedRenderLookup (#195)', () => {
	it('defaults stay well under the ~20 s stall it guards against', () => {
		assert.ok(RENDER_LOOKUP_TIMEOUT_MS <= 3_000);
		assert.ok(RENDER_LOOKUP_SLOW_MS < RENDER_LOOKUP_TIMEOUT_MS);
	});

	it('returns a fast result and logs nothing', async () => {
		const { lines, log } = recorder();
		assert.equal(await timedRenderLookup('x', async () => 42, { log }), 42);
		assert.deepEqual(lines, []);
	});

	it('rejects with RenderLookupTimeoutError when the lookup hangs, and logs the timeout', async () => {
		const { lines, log } = recorder();
		const started = Date.now();
		await assert.rejects(
			timedRenderLookup('hero_alt.media', () => new Promise<never>(() => {}), { timeoutMs: 30, log }),
			(err: unknown) => err instanceof RenderLookupTimeoutError && /hero_alt\.media timed out after 30 ms/.test(err.message),
		);
		assert.ok(Date.now() - started < 1_000);
		assert.equal(lines.length, 1);
		assert.equal(lines[0][0], RENDER_LOOKUP_TIMEOUT_LOG);
		const detail = JSON.parse(String(lines[0][1])) as { label: string; timeoutMs: number; ms: number };
		assert.equal(detail.label, 'hero_alt.media');
		assert.equal(detail.timeoutMs, 30);
	});

	it('logs a slow success with its duration', async () => {
		const { lines, log } = recorder();
		let t = 0;
		const now = () => t;
		const value = await timedRenderLookup(
			'social_image.media',
			async () => {
				t = 900;
				return 'ok';
			},
			{ log, now, slowMs: 750 },
		);
		assert.equal(value, 'ok');
		assert.equal(lines.length, 1);
		assert.equal(lines[0][0], RENDER_SLOW_LOOKUP_LOG);
		assert.deepEqual(JSON.parse(String(lines[0][1])), { label: 'social_image.media', ms: 900, outcome: 'ok' });
	});

	it('passes a lookup error through and logs it only when slow', async () => {
		const { lines, log } = recorder();
		await assert.rejects(timedRenderLookup('x', async () => {
			throw new Error('turso down');
		}, { log }), /turso down/);
		assert.deepEqual(lines, []);

		let t = 0;
		await assert.rejects(
			timedRenderLookup('x', async () => {
				t = 1_000;
				throw new Error('slow failure');
			}, { log, now: () => t, slowMs: 750 }),
			/slow failure/,
		);
		assert.equal(lines.length, 1);
		assert.deepEqual(JSON.parse(String(lines[0][1])), { label: 'x', ms: 1_000, outcome: 'error' });
	});
});

describe('RenderLookupBudget: one timeout per render / request (#195)', () => {
	it('the first timeout trips the budget; later lookups are skipped without running', async () => {
		const { lines, log } = recorder();
		const budget = createRenderLookupBudget();
		assert.equal(budget.trippedBy, null);
		await assert.rejects(
			timedRenderLookup('hero_alt.media', () => new Promise<never>(() => {}), { timeoutMs: 20, log, budget }),
			RenderLookupTimeoutError,
		);
		assert.equal(budget.trippedBy, 'hero_alt.media');

		let ran = false;
		await assert.rejects(
			timedRenderLookup('social_image.media', async () => {
				ran = true;
				return 1;
			}, { log, budget }),
			(err: unknown) =>
				err instanceof RenderLookupSkippedError
				&& /social_image\.media skipped: render lookup budget tripped by hero_alt\.media/.test(err.message),
		);
		assert.equal(ran, false);
		assert.equal(lines.length, 1, 'only the timeout is logged; a skip adds no line');
	});

	it('errors and slow successes do not trip the budget', async () => {
		const budget = createRenderLookupBudget();
		await assert.rejects(timedRenderLookup('x', async () => {
			throw new Error('turso down');
		}, { budget, log: { warn: () => {} } }), /turso down/);
		let t = 0;
		await timedRenderLookup('y', async () => {
			t = 1_000;
		}, { budget, now: () => t, log: { warn: () => {} } });
		assert.equal(budget.trippedBy, null);
	});

	it('keeps the first tripping label', () => {
		const budget = createRenderLookupBudget();
		budget.trip('a');
		budget.trip('b');
		assert.equal(budget.trippedBy, 'a');
	});

	it('isRenderLookupBoundError matches only timeouts and skips', () => {
		assert.equal(isRenderLookupBoundError(new RenderLookupTimeoutError('x', 1)), true);
		assert.equal(isRenderLookupBoundError(new RenderLookupSkippedError('x', 'y')), true);
		assert.equal(isRenderLookupBoundError(new Error('turso down')), false);
	});
});
