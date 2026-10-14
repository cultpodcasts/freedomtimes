import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toWeeklyRecords, weeklySlugRange } from '../src/lib/seo/weekly-list-core.ts';

describe('weekly list', () => {
	it('slug range covers exactly the weekly-summary- prefix', () => {
		const { gte, lt } = weeklySlugRange();
		const inRange = (s: string) => s >= gte && s < lt;
		assert.ok(inRange('weekly-summary-8-june-2026'));
		assert.ok(inRange('weekly-summary-zzz'));
		assert.ok(!inRange('weekly-summary'));
		assert.ok(!inRange('weekly-summaryx'));
		assert.ok(!inRange('about-us'));
		assert.ok(!inRange('weekly-summary.x'));
	});

	it('filters non-weekly slugs and sorts oldest → newest by London coverage date', () => {
		const recs = toWeeklyRecords([
			{ id: 'b', data: { slug: 'weekly-summary-b', title: 'B', coverage_start: '2026-10-03T23:00:00Z' } },
			{ id: 'x', data: { slug: 'about-us', title: 'X' } },
			{ id: 'a', data: { slug: 'weekly-summary-a', title: 'A', coverage_start: '2026-09-27' } },
		]);
		assert.deepEqual(recs.map((r) => [r.slug, r.sortDate]), [['weekly-summary-a', '2026-09-27'], ['weekly-summary-b', '2026-10-04']]);
	});
});
