import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	compareInventories,
	databaseNameFromHostname,
	databaseNameFromUrl,
	isKnownProductionBackupBranch,
	weeklySlugsSample,
} from "./production-emdash-inventory.mjs";

describe("databaseNameFromHostname", () => {
	it("strips org + region from Worker-resolved work-embeds host", () => {
		assert.equal(
			databaseNameFromHostname(
				"prod-work-embeds-20260729-183444-cultpodcasts.aws-eu-west-1.turso.io",
				"cultpodcasts",
			),
			"prod-work-embeds-20260729-183444",
		);
	});

	it("does not assume named freedomtimes-emdash-production", () => {
		assert.equal(
			databaseNameFromHostname(
				"freedomtimes-emdash-production-cultpodcasts.aws-eu-west-1.turso.io",
				"cultpodcasts",
			),
			"freedomtimes-emdash-production",
		);
	});

	it("parses libsql URLs", () => {
		assert.equal(
			databaseNameFromUrl(
				"libsql://prod-rollback-20260907-163120-cultpodcasts.aws-eu-west-1.turso.io",
				"cultpodcasts",
			),
			"prod-rollback-20260907-163120",
		);
		assert.equal(
			databaseNameFromUrl(
				"libsql://prod-backup-20260908-140000-cultpodcasts.aws-eu-west-1.turso.io",
				"cultpodcasts",
			),
			"prod-backup-20260908-140000",
		);
	});
});

describe("isKnownProductionBackupBranch", () => {
	it("accepts new prod-backup-* and legacy prod-rollback-*", () => {
		assert.equal(isKnownProductionBackupBranch("prod-backup-20260908-140000"), true);
		assert.equal(isKnownProductionBackupBranch("prod-rollback-20260907-163120"), true);
		assert.equal(isKnownProductionBackupBranch("prod-work-embeds-20260729-183444"), false);
	});
});

describe("compareInventories", () => {
	const live = [
		{ slug: "weekly-summary-1-september-2026", status: "published" },
		{ slug: "weekly-summary-6-september-2026", status: "published" },
		{ slug: "introducing-freedom-times-uk-europe-survivor-advocacy", status: "published" },
	];

	it("FAIL when backup is thin vs live", () => {
		const backup = live.slice(0, 1);
		const r = compareInventories(backup, live);
		assert.equal(r.pass, false);
		assert.equal(r.thinVsLive, true);
		assert.deepEqual(r.missingInBackup, [
			"weekly-summary-6-september-2026",
			"introducing-freedom-times-uk-europe-survivor-advocacy",
		]);
	});

	it("FAIL when live weeklies present on staging are missing from backup", () => {
		const backup = [
			{ slug: "introducing-freedom-times-uk-europe-survivor-advocacy", status: "published" },
		];
		const r = compareInventories(backup, live, {
			stagingPublishedSlugs: live.map((p) => p.slug),
		});
		assert.equal(r.pass, false);
		assert.ok(r.missingRecentWeekliesVsStaging.includes("weekly-summary-1-september-2026"));
	});

	it("PASS when backup matches live published set", () => {
		const r = compareInventories(live, live, {
			stagingPublishedSlugs: live.map((p) => p.slug),
		});
		assert.equal(r.pass, true);
		assert.equal(r.backupCount, 3);
		assert.deepEqual(weeklySlugsSample(live), [
			"weekly-summary-1-september-2026",
			"weekly-summary-6-september-2026",
		]);
	});
});
