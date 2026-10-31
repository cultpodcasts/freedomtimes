// node --test scripts/turso-backup-retention.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
	databasesMatchingHostHash,
	databasesMatchingUrls,
	defaultRules,
	deleteRefusals,
	matchRule,
	parseNameStamp,
	planRetention,
	protectedFromBackupRecords,
	summarisePlan,
	tursoHostHash,
} from "./turso-backup-retention.mjs";

const NOW = new Date("2026-10-31T12:00:00Z");
const ORG = "exampleorg";
const rules = defaultRules();

function stamp(daysAgo) {
	const d = new Date(NOW.getTime() - daysAgo * 86_400_000);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
function db(name, extra = {}) {
	return { Name: name, Hostname: `${name}-${ORG}.aws-eu-west-1.turso.io`, primaryRegion: "aws-eu-west-1", ...extra };
}
const byName = (plan) => Object.fromEntries(plan.map((e) => [e.name, e]));

test("only stamped CI prefixes are candidates", () => {
	for (const n of ["staging-backup-20261001-120000", "prod-backup-20261001-120000", "ci-staging-backup-20261001-120000", "ci-rollback-20261001-120000"]) {
		assert.ok(matchRule(n, rules), n);
	}
	for (const n of [
		"freedomtimes-emdash-production",
		"freedomtimes-emdash-staging",
		"prod-rollback-20261001-120000",
		"prod-work-20261001-120000",
		"prod-recovery-20261001-120000",
		"prod-backup-manual",
		"prod-backup-20261001-120000-extra",
		"xprod-backup-20261001-120000",
		"staging-backup-2026100-120000",
	]) {
		assert.equal(matchRule(n, rules), null, n);
	}
	assert.equal(matchRule("ci-staging-backup-20261001-120000", rules).prefix, "ci-staging-backup-");
});

test("name stamp parses as UTC and rejects impossible dates", () => {
	const r = matchRule("prod-backup-20261001-120000", rules);
	assert.equal(parseNameStamp("prod-backup-20261001-120000", r).toISOString(), "2026-10-01T12:00:00.000Z");
	assert.equal(parseNameStamp("prod-backup-20261341-120000", r), null);
});

test("unknown names and named DBs never appear in the plan", () => {
	const plan = planRetention({
		databases: [db("freedomtimes-emdash-production"), db("prod-rollback-20200101-000000"), db("prod-work-20200101-000000")],
		rules,
		now: NOW,
	});
	assert.deepEqual(plan, []);
});

test("staging: keeps newest 10 and anything younger than 7 days", () => {
	const dbs = Array.from({ length: 14 }, (_, i) => db(`staging-backup-${stamp(i * 2 + 1)}`));
	const plan = planRetention({ databases: dbs, rules, now: NOW });
	const del = plan.filter((e) => e.action === "delete");
	assert.equal(del.length, 4);
	assert.ok(del.every((e) => e.ageDays >= 7));
	const sorted = [...plan].sort((a, b) => a.ageDays - b.ageDays);
	assert.ok(sorted.slice(0, 10).every((e) => e.action === "keep"));
});

test("production: keeps newest 5, anything younger than 30 days, and the newest even when old", () => {
	const dbs = [40, 50, 60, 70, 80, 90, 100].map((d) => db(`prod-backup-${stamp(d)}`));
	const plan = planRetention({ databases: dbs, rules, now: NOW });
	const kept = plan.filter((e) => e.action === "keep").map((e) => e.ageDays);
	assert.deepEqual(kept.sort((a, b) => a - b), [40, 50, 60, 70, 80]);
	const newest = plan.find((e) => e.ageDays === 40);
	assert.ok(newest.reasons.some((r) => r.includes("last deploy rollback target")));
});

test("protect map, delete protection and unknown age always keep", () => {
	const old = [200, 210, 220, 230, 240, 250, 260, 270].map((d) => `prod-backup-${stamp(d)}`);
	const protect = new Map([[old[7], ["live production Worker DB"]]]);
	const dbs = old.map((n, i) => db(n, i === 6 ? { delete_protection: true } : {}));
	const plan = byName(planRetention({ databases: dbs, rules, now: NOW, protect }));
	assert.equal(plan[old[7]].action, "keep");
	assert.deepEqual(plan[old[7]].reasons, ["live production Worker DB"]);
	assert.equal(plan[old[6]].action, "keep");
	assert.equal(plan[old[5]].action, "delete");
});

test("branched_at overrides the name stamp for age", () => {
	const name = `staging-backup-${stamp(100)}`;
	const plan = planRetention({
		databases: [db(name, { parent: { branched_at: new Date(NOW.getTime() - 86_400_000).toISOString() } })],
		rules: defaultRules({ stagingKeepNewest: 1 }),
		now: NOW,
	});
	assert.equal(plan[0].createdSource, "branched_at");
	assert.equal(plan[0].ageDays, 1);
});

test("floors refuse unsafe production policy", () => {
	assert.throws(() => defaultRules({ productionKeepNewest: 2 }));
	assert.throws(() => defaultRules({ productionKeepDays: 13 }));
	assert.throws(() => defaultRules({ stagingKeepNewest: 0 }));
});

test("live host hash and URL matching find the DB without printing hosts", () => {
	const dbs = [db("freedomtimes-emdash-production"), db("prod-backup-20260901-000000"), { Name: "prod-backup-20260902-000000", Hostname: `prod-backup-20260902-000000-${ORG}.turso.io`, primaryRegion: "aws-eu-west-1" }];
	const h = tursoHostHash(`prod-backup-20260901-000000-${ORG}.aws-eu-west-1.turso.io`);
	assert.deepEqual(databasesMatchingHostHash(dbs, h, ORG), ["prod-backup-20260901-000000"]);
	// API returns the region-less form but the Worker URL carries the region
	const h2 = tursoHostHash(`prod-backup-20260902-000000-${ORG}.aws-eu-west-1.turso.io`);
	assert.deepEqual(databasesMatchingHostHash(dbs, h2, ORG), ["prod-backup-20260902-000000"]);
	assert.deepEqual(databasesMatchingHostHash(dbs, null, ORG), []);
	assert.deepEqual(
		databasesMatchingUrls(dbs, [`libsql://freedomtimes-emdash-production-${ORG}.aws-eu-west-1.turso.io?x=1`, undefined], ORG),
		["freedomtimes-emdash-production"],
	);
});

test("backup records: newest verified and newest referenced", () => {
	const ev = protectedFromBackupRecords([
		{ file: "a.json", data: { createdAtUtc: "2026-10-01T00:00:00Z", backupDatabase: "prod-backup-20261001-000000", verificationPass: true } },
		{ file: "b.json", data: { createdAtUtc: "2026-10-20T00:00:00Z", destination: { tursoBranch: "prod-backup-20261020-000000" }, verificationPass: true } },
		{ file: "c.json", data: { createdAtUtc: "2026-10-25T00:00:00Z", backupDatabase: "prod-backup-20261025-000000", verificationPass: false } },
		{ file: "d.json", data: { createdAtUtc: "2026-10-26T00:00:00Z", backupDatabase: "" } },
	]);
	assert.equal(ev.newestVerified, "prod-backup-20261020-000000");
	assert.equal(ev.lastReferenced, "prod-backup-20261025-000000");
	assert.deepEqual(protectedFromBackupRecords([]), { newestVerified: null, lastReferenced: null });
});

test("delete refusals: CI, count mismatch, unidentified live DBs", () => {
	const plan = [
		{ name: "staging-backup-20200101-000000", environment: "staging", action: "delete" },
		{ name: "prod-backup-20200101-000000", environment: "production", action: "delete" },
		{ name: "prod-backup-20261030-000000", environment: "production", action: "keep" },
	];
	const ok = { identified: true };
	assert.deepEqual(deleteRefusals({ plan, expectCount: 2, env: {}, liveProduction: ok, liveStaging: ok }), []);
	assert.equal(deleteRefusals({ plan, expectCount: 2, env: { GITHUB_ACTIONS: "true" }, liveProduction: ok, liveStaging: ok }).length, 1);
	assert.equal(deleteRefusals({ plan, expectCount: undefined, env: {}, liveProduction: ok, liveStaging: ok }).length, 1);
	assert.equal(deleteRefusals({ plan, expectCount: 3, env: {}, liveProduction: ok, liveStaging: ok }).length, 1);
	assert.equal(deleteRefusals({ plan, expectCount: 2, env: {}, liveProduction: { identified: false }, liveStaging: ok }).length, 1);
	assert.equal(deleteRefusals({ plan, expectCount: 2, env: {}, liveProduction: ok, liveStaging: { identified: false } }).length, 1);
	const prodOnly = plan.filter((e) => e.environment === "production");
	assert.deepEqual(deleteRefusals({ plan: prodOnly, expectCount: 1, env: {}, liveProduction: ok, liveStaging: { identified: false } }), []);
});

test("summary counts per prefix", () => {
	const dbs = [1, 2, 40, 50, 60, 70, 80, 90].map((d) => db(`prod-backup-${stamp(d)}`));
	const s = summarisePlan(planRetention({ databases: dbs, rules, now: NOW }), rules).find((x) => x.prefix === "prod-backup-");
	assert.equal(s.total, 8);
	assert.equal(s.wouldDelete, 3);
	assert.deepEqual(s.deleteAgeRangeDays, [70, 90]);
});

test("--help runs without credentials and the CLI never deletes by default", async () => {
	const { execFileSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const script = fileURLToPath(new URL("./turso-backup-retention.mjs", import.meta.url));
	const out = execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" });
	assert.match(out, /Dry-run by default/);
	assert.match(out, /--expect-count/);
});
