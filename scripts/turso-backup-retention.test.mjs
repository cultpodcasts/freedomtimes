// node --test scripts/turso-backup-retention.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
	databasesMatchingHostHash,
	databasesMatchingUrls,
	defaultRules,
	deleteRefusals,
	deleteWithLocalCopies,
	ensureLocalCopy,
	localBackupPath,
	matchRule,
	parseNameStamp,
	planRetention,
	protectedFromBackupRecords,
	summarisePlan,
	tursoHostHash,
	unmatchedProtectNames,
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
	for (const n of [
		"staging-rollback-20261001-120000",
		"staging-backup-20261001-120000",
		"prod-rollback-20261001-120000",
		"prod-backup-20261001-120000",
		"ci-staging-backup-20261001-120000",
		"ci-rollback-20261001-120000",
	]) {
		assert.ok(matchRule(n, rules), n);
	}
	for (const n of [
		"freedomtimes-emdash-production",
		"freedomtimes-emdash-staging",
		"prod-rollback-pre-cutover",
		"prod-rollback-20261001-120000-extra",
		"staging-rollback-manual",
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
	assert.equal(matchRule("ci-rollback-20261001-120000", rules).prefix, "ci-rollback-");
	assert.equal(matchRule("prod-rollback-20261001-120000", rules).prefix, "prod-rollback-");
	assert.equal(matchRule("staging-rollback-20261001-120000", rules).prefix, "staging-rollback-");
});

test("name stamp parses as UTC and rejects impossible dates", () => {
	const r = matchRule("prod-backup-20261001-120000", rules);
	assert.equal(parseNameStamp("prod-backup-20261001-120000", r).toISOString(), "2026-10-01T12:00:00.000Z");
	assert.equal(parseNameStamp("prod-backup-20261341-120000", r), null);
});

test("unknown names and named DBs never appear in the plan", () => {
	const plan = planRetention({
		databases: [
			db("freedomtimes-emdash-production"),
			db("freedomtimes-emdash-staging"),
			db("prod-rollback-pre-cutover"),
			db("prod-work-20200101-000000"),
			db("prod-work-embeds-20260729-183444"),
		],
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
	// Count rule on its own: maximum age raised out of the way.
	const plan = planRetention({ databases: dbs, rules: defaultRules({ maxAgeDays: 3650 }), now: NOW });
	const kept = plan.filter((e) => e.action === "keep").map((e) => e.ageDays);
	assert.deepEqual(kept.sort((a, b) => a - b), [40, 50, 60, 70, 80]);
	const newest = plan.find((e) => e.ageDays === 40);
	assert.ok(newest.reasons.some((r) => r.includes("last deploy rollback target")));
	// Default 30d maximum age: only the floor of 3 survives when every branch is old.
	const capped = planRetention({ databases: dbs, rules, now: NOW });
	assert.deepEqual(capped.filter((e) => e.action === "keep").map((e) => e.ageDays).sort((a, b) => a - b), [40, 50, 60]);
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

test("max age: count keeps yield above the floors, always-kept branches stay", () => {
	const names = [5, 10, 35, 40, 45, 50, 55].map((d) => `prod-backup-${stamp(d)}`);
	const staging = [31, 32].map((d) => `staging-backup-${stamp(d)}`);
	const protect = new Map([[names[6], ["--protect"]]]);
	const plan = byName(
		planRetention({ databases: [...names, ...staging].map((n) => db(n)), rules: defaultRules({ productionKeepNewest: 6 }), now: NOW, protect }),
	);
	// Newest 3 (5d, 10d, 35d) are the production floor; 40d..50d are within keep-newest 6 but over 30d.
	assert.equal(plan[names[0]].action, "keep");
	assert.equal(plan[names[2]].action, "keep");
	assert.match(plan[names[2]].reasons.join(";"), /floor/);
	for (const n of names.slice(3, 6)) {
		assert.equal(plan[n].action, "delete", n);
		assert.match(plan[n].reasons.join(";"), /30d maximum age/);
	}
	assert.equal(plan[names[6]].action, "keep");
	assert.equal(plan[staging[0]].action, "keep");
	assert.equal(plan[staging[1]].action, "delete");
	// Without the maximum age (raised to 60d) keep-newest 6 keeps 40d..50d again.
	const relaxed = byName(planRetention({ databases: names.map((n) => db(n)), rules: defaultRules({ productionKeepNewest: 6, maxAgeDays: 60 }), now: NOW }));
	assert.equal(relaxed[names[5]].action, "keep");
});

test("floors refuse unsafe production policy", () => {
	assert.throws(() => defaultRules({ maxAgeDays: 13 }));
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
	// Default 30d maximum age: newest 3 (1d, 2d, 40d) are the floor; 50d..90d go.
	assert.equal(s.wouldDelete, 5);
	assert.deepEqual(s.deleteAgeRangeDays, [50, 90]);
});

test("--help runs without credentials and the CLI never deletes by default", async () => {
	const { execFileSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const script = fileURLToPath(new URL("./turso-backup-retention.mjs", import.meta.url));
	const out = execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" });
	assert.match(out, /Dry-run by default/);
	assert.match(out, /--expect-count/);
});

test("--allow-unverified-staging only lifts the staging provenance gate", () => {
	const plan = [
		{ name: "staging-backup-20200101-000000", environment: "staging", action: "delete" },
		{ name: "prod-backup-20200101-000000", environment: "production", action: "delete" },
	];
	const base = { plan, expectCount: 2, env: {}, liveStaging: { identified: false } };
	assert.deepEqual(deleteRefusals({ ...base, liveProduction: { identified: true }, allowUnverifiedStaging: true }), []);
	assert.equal(deleteRefusals({ ...base, liveProduction: { identified: true } }).length, 1);
	assert.match(deleteRefusals({ ...base, liveProduction: { identified: true } })[0], /--allow-unverified-staging/);
	// production stays strict
	assert.equal(deleteRefusals({ ...base, liveProduction: { identified: false }, allowUnverifiedStaging: true }).length, 1);
});

test("unmatched --protect names are reported and block --delete", () => {
	const dbs = [db("prod-backup-20260901-000000"), db("freedomtimes-emdash-production")];
	assert.deepEqual(unmatchedProtectNames(["prod-backup-20260901-000000", "prod-bakup-20260901-000000", "prod-bakup-20260901-000000"], dbs), ["prod-bakup-20260901-000000"]);
	assert.deepEqual(unmatchedProtectNames([], dbs), []);
	const ok = { identified: true };
	const refusals = deleteRefusals({ plan: [], expectCount: 0, env: {}, liveProduction: ok, liveStaging: ok, unmatchedProtect: ["prod-bakup-20260901-000000"] });
	assert.equal(refusals.length, 1);
	assert.match(refusals[0], /not a database/);
});

// --- export before delete (Jon's policy: older copies live only as gitignored local .db files) ---

const DIR = "/repo/.release/backups";
const COUNTS = { raw: 12, active: 11, published: 9 };
const prodEntry = { name: "prod-backup-20260907-175920", prefix: "prod-backup-", environment: "production", ageDays: 53.6 };
const stagingEntry = { name: "staging-backup-20261013-222328", prefix: "staging-backup-", environment: "staging", ageDays: 17.5 };

function fakeDeps(over = {}) {
	const files = new Map(Object.entries(over.files || {}));
	const calls = { exported: [], renamed: [], removed: [], branchCounts: 0 };
	const deps = {
		isIgnored: () => true,
		exists: (p) => files.has(p),
		size: (p) => files.get(p)?.size ?? 0,
		exportBranch: async (name, out) => {
			calls.exported.push([name, out]);
			files.set(out, over.exported ?? { size: 4096, integrity: "ok", counts: COUNTS });
		},
		fileCheck: async (p) => ({ integrity: files.get(p).integrity, counts: files.get(p).counts }),
		branchCounts: async () => {
			calls.branchCounts++;
			return over.branch ?? COUNTS;
		},
		rename: (a, b) => {
			calls.renamed.push([a, b]);
			files.set(b, files.get(a));
			files.delete(a);
		},
		remove: (p) => {
			calls.removed.push(p);
			files.delete(p);
		},
		...over.deps,
	};
	return { deps, calls, files };
}

test("localBackupPath: emdash-<env>-<stamp>.db under the backups dir", () => {
	assert.equal(localBackupPath(prodEntry, DIR), path.join(DIR, "emdash-production-20260907-175920.db"));
	assert.equal(localBackupPath(stagingEntry, DIR), path.join(DIR, "emdash-staging-20261013-222328.db"));
	assert.equal(
		localBackupPath({ name: "ci-rollback-20260101-010101", prefix: "ci-rollback-", environment: "production" }, DIR),
		path.join(DIR, "emdash-production-20260101-010101.db"),
	);
	assert.throws(() => localBackupPath({ name: "prod-backup-x", prefix: "prod-backup-", environment: "production" }, DIR));
});

test("ensureLocalCopy: exports to .partial, verifies, then renames into place", async () => {
	const { deps, calls, files } = fakeDeps();
	const r = await ensureLocalCopy(prodEntry, DIR, deps);
	const final = path.join(DIR, "emdash-production-20260907-175920.db");
	assert.equal(r.ok, true);
	assert.equal(r.action, "exported");
	assert.deepEqual(calls.exported, [[prodEntry.name, `${final}.partial`]]);
	assert.deepEqual(calls.renamed, [[`${final}.partial`, final]]);
	assert.ok(files.has(final));
	assert.equal(calls.branchCounts, 1);
});

test("ensureLocalCopy: an existing verified copy is kept and not exported again", async () => {
	const final = path.join(DIR, "emdash-production-20260907-175920.db");
	const { deps, calls } = fakeDeps({ files: { [final]: { size: 4096, integrity: "ok", counts: COUNTS } } });
	const r = await ensureLocalCopy(prodEntry, DIR, deps);
	assert.equal(r.ok, true);
	assert.equal(r.action, "existing");
	assert.deepEqual(calls.exported, []);
	assert.deepEqual(calls.renamed, []);
});

test("ensureLocalCopy: an existing copy that does not verify is left untouched and the branch is kept", async () => {
	const final = path.join(DIR, "emdash-production-20260907-175920.db");
	const { deps, calls, files } = fakeDeps({ files: { [final]: { size: 4096, integrity: "ok", counts: { ...COUNTS, published: 8 } } } });
	const r = await ensureLocalCopy(prodEntry, DIR, deps);
	assert.equal(r.ok, false);
	assert.match(r.detail, /does not verify.*post counts differ.*left untouched/);
	assert.deepEqual(calls.exported, []);
	assert.deepEqual(calls.removed, []);
	assert.ok(files.has(final));
});

test("ensureLocalCopy: refuses when the path is not gitignored (nothing exported)", async () => {
	const { deps, calls } = fakeDeps({ deps: { isIgnored: () => false } });
	const r = await ensureLocalCopy(stagingEntry, DIR, deps);
	assert.equal(r.ok, false);
	assert.match(r.detail, /not gitignored/);
	assert.deepEqual(calls.exported, []);
});

test("ensureLocalCopy: failed export, empty file, bad integrity or count mismatch -> not ok, partial removed", async () => {
	const cases = [
		[{ deps: { exportBranch: async () => { throw new Error("turso db export exited 1"); } } }, /export failed/],
		[{ exported: { size: 0, integrity: "ok", counts: COUNTS } }, /missing or empty/],
		[{ exported: { size: 4096, integrity: "*** in database main ***", counts: COUNTS } }, /integrity_check/],
		[{ branch: { raw: 13, active: 12, published: 10 } }, /post counts differ/],
		[{ deps: { branchCounts: async () => { throw new Error("no url"); } } }, /local copy check failed/],
	];
	for (const [over, re] of cases) {
		const { deps, calls, files } = fakeDeps(over);
		const r = await ensureLocalCopy(stagingEntry, DIR, deps);
		assert.equal(r.ok, false, String(re));
		assert.equal(r.action, "skipped");
		assert.match(r.detail, re);
		assert.deepEqual(calls.renamed, [], String(re));
		assert.deepEqual([...files.keys()].filter((k) => k.startsWith(path.join(DIR, "emdash-staging-"))), [], String(re));
	}
});

test("deleteWithLocalCopies: deletes only branches whose local copy verified", async () => {
	const deletedNames = [];
	const log = [];
	const { deleted, skipped } = await deleteWithLocalCopies([prodEntry, stagingEntry], {
		ensure: async (e) =>
			e === prodEntry
				? { ok: true, action: "existing", file: "emdash-production-20260907-175920.db", detail: "existing local copy verified" }
				: { ok: false, action: "skipped", file: "emdash-staging-20261013-222328.db", detail: "export failed (x)" },
		del: async (n) => deletedNames.push(n),
		log: (l) => log.push(l),
	});
	assert.deepEqual(deletedNames, [prodEntry.name]);
	assert.deepEqual(deleted.map((d) => d.name), [prodEntry.name]);
	assert.deepEqual(skipped.map((d) => d.name), [stagingEntry.name]);
	assert.match(log.join("\n"), /NOT deleted staging-backup-20261013-222328/);
});

// --- naming (Jon, 31 Oct 2026): new backups are prod-rollback-<stamp> / staging-rollback-<stamp> ---

test("families: old and new names count together for keep-newest, floors and the newest production backup", () => {
	const dbs = [
		db(`prod-rollback-${stamp(40)}`), // newest of the family (new name)
		db(`prod-backup-${stamp(45)}`),
		db(`prod-backup-${stamp(50)}`),
		db(`prod-rollback-${stamp(60)}`), // legacy checkpoint name
		db(`prod-backup-${stamp(70)}`),
		db(`staging-rollback-${stamp(20)}`),
		db(`staging-backup-${stamp(35)}`),
	];
	const plan = byName(planRetention({ databases: dbs, rules, now: NOW }));
	const keep = (n) => plan[n].action === "keep";
	// production floor 3 across both prefixes; the newest carries the rollback-target reason
	assert.ok(keep(`prod-rollback-${stamp(40)}`));
	assert.match(plan[`prod-rollback-${stamp(40)}`].reasons.join(";"), /newest prod-rollback-\*\/prod-backup-\* \(last deploy rollback target\)/);
	assert.ok(keep(`prod-backup-${stamp(45)}`));
	assert.ok(keep(`prod-backup-${stamp(50)}`));
	assert.equal(plan[`prod-rollback-${stamp(60)}`].action, "delete");
	assert.equal(plan[`prod-backup-${stamp(70)}`].action, "delete");
	// staging floor 1 across both prefixes: only the newest stays past the maximum age
	assert.ok(keep(`staging-rollback-${stamp(20)}`));
	assert.equal(plan[`staging-backup-${stamp(35)}`].action, "delete");
	assert.equal(plan[`staging-rollback-${stamp(20)}`].environment, "staging");
});

test("families: once a prod-rollback-* exists, an older prod-backup-* is no longer the newest", () => {
	const plan = byName(
		planRetention({ databases: [db(`prod-backup-${stamp(1)}`), db(`prod-rollback-${stamp(0.5)}`)], rules, now: NOW }),
	);
	assert.match(plan[`prod-rollback-${stamp(0.5)}`].reasons.join(";"), /last deploy rollback target/);
	assert.doesNotMatch(plan[`prod-backup-${stamp(1)}`].reasons.join(";"), /last deploy rollback target/);
});

test("localBackupPath: new names map to the same emdash-<env>-<stamp>.db files", () => {
	assert.equal(
		localBackupPath({ name: "prod-rollback-20261031-090000", prefix: "prod-rollback-", environment: "production" }, DIR),
		path.join(DIR, "emdash-production-20261031-090000.db"),
	);
	assert.equal(
		localBackupPath({ name: "staging-rollback-20261031-090000", prefix: "staging-rollback-", environment: "staging" }, DIR),
		path.join(DIR, "emdash-staging-20261031-090000.db"),
	);
});
