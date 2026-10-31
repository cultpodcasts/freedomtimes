import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	compareInventories,
	databaseNameFromHostname,
	databaseNameFromUrl,
	isKnownProductionBackupBranch,
	parseTursoHostname,
	resolveTursoOrganization,
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
	it("accepts prod-rollback-* and the older prod-backup-*", () => {
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

describe("Turso org suffix (prod backup DB-name bug)", () => {
	const HOST = "freedomtimes-emdash-production-freedomtimes.aws-eu-west-1.turso.io";

	it("strips the real org from TF_VAR_TURSO_ORGANIZATION", () => {
		const env = { TF_VAR_TURSO_ORGANIZATION: "freedomtimes" };
		assert.deepEqual(parseTursoHostname(HOST, { env }), {
			databaseName: "freedomtimes-emdash-production", organization: "freedomtimes", orgStripped: true,
		});
		assert.equal(
			parseTursoHostname("prod-backup-20261014-100000-freedomtimes.aws-eu-west-1.turso.io", { env }).databaseName,
			"prod-backup-20261014-100000",
		);
	});

	it("strips the org via the known production DB name when no org is configured", () => {
		assert.deepEqual(parseTursoHostname(`libsql://${HOST}`.replace("libsql://", ""), { env: {} }), {
			databaseName: "freedomtimes-emdash-production", organization: "freedomtimes", orgStripped: true,
		});
	});

	it("does not return a name with the org still attached as if it were stripped", () => {
		const r = parseTursoHostname("prod-work-x-freedomtimes.turso.io", { env: {} });
		assert.equal(r.orgStripped, false);
	});

	it("mismatched org falls back to the known name instead of leaving the suffix", () => {
		assert.equal(parseTursoHostname(HOST, { organization: "cultpodcasts", env: {} }).databaseName, "freedomtimes-emdash-production");
	});

	it("resolveTursoOrganization precedence, no hard-coded default", () => {
		assert.equal(resolveTursoOrganization(undefined, {}), "");
		assert.equal(resolveTursoOrganization(undefined, { TF_VAR_TURSO_ORGANIZATION: "FreedomTimes" }), "freedomtimes");
		assert.equal(resolveTursoOrganization("a", { TURSO_ORGANIZATION: "b" }), "a");
		assert.equal(resolveTursoOrganization(undefined, { TURSO_ORGANIZATION: "b", TF_VAR_TURSO_ORGANIZATION: "c" }), "b");
	});
});
