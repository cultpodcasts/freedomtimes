#!/usr/bin/env node
/**
 * Turso CI backup branch retention (#143). Dry-run by default.
 *
 * Every deploy creates a Turso database branch that nothing deletes:
 *   staging-rollback-YYYYMMDD-HHMMSS    deploy-worker.yml staging job (every PR push); before
 *                                       31 Oct 2026 named staging-backup-YYYYMMDD-HHMMSS
 *   prod-rollback-YYYYMMDD-HHMMSS       deploy-worker.yml production job / backup-production-emdash.ps1;
 *                                       before 31 Oct 2026 named prod-backup-YYYYMMDD-HHMMSS (and,
 *                                       before that, legacy prod-rollback-* checkpoints)
 *   ci-staging-backup-YYYYMMDD-HHMMSS   legacy terraform-staging.yml mutate dispatch
 *   ci-rollback-YYYYMMDD-HHMMSS         legacy terraform-production.yml mutate dispatch
 * Old and new names of the same backup (prod-rollback-/prod-backup-, staging-rollback-/
 * staging-backup-) are counted together for the keep-newest rules and floors.
 * They count against the Turso plan's database/storage limits; at the limit the fail-closed
 * backup step (and so the deploy) fails. This script lists them with ages and says which ones
 * the policy would delete. It deletes nothing unless run with --delete --expect-count N.
 *
 * Only names that match one of the prefixes above **and** end in a YYYYMMDD-HHMMSS stamp are
 * candidates. Everything else is never touched: named DBs (freedomtimes-emdash-production,
 * freedomtimes-emdash-staging), DR targets, prod-work-*, prod-recovery-*, prod-rollback-<not a
 * stamp>, anything unrecognised.
 *
 * Always kept (whatever the age):
 *   - the newest N branches of each family (staging 10, production 5) and anything younger than
 *     the minimum age (staging 7 days, production 30 days), up to the maximum age (30 days), above
 *     the floors (newest 3 production, newest 1 staging per family);
 *   - the newest prod-rollback-* or prod-backup-* (the rollback target of the last deploy: every
 *     production deploy takes one before it migrates) and the newest *verified* backup from local
 *     .release/rollback-branches/*.json metadata and freedomtimes-agents/data/backups/*.json logs,
 *     plus the branch the newest metadata file names (last local deploy/backup);
 *   - any branch the live production or staging Worker uses (matched by the host hash in
 *     /api/deploy-provenance.json, e.g. after a DR retarget to a backup branch);
 *   - any branch named by a libsql URL in the environment (TURSO_DATABASE_URL,
 *     TURSO_PRODUCTION_EMDASH_DB_URL, ...), Turso delete protection, or --protect NAME.
 *
 * --delete refuses to run on GitHub Actions, refuses unless the live production Worker's DB was
 * identified among the organisation's databases (and the staging one, if any staging branch would
 * be deleted, unless --allow-unverified-staging: staging is behind the Auth0 lock), refuses while a
 * --protect name is not a database in the organisation, and refuses unless --expect-count equals
 * the number of branches the plan deletes.
 *
 * Export before delete (Jon's policy, 31 Oct 2026): Turso keeps about a month of backup branches;
 * older copies live only as gitignored local .db files on the operator's machine (the MSI), never
 * anywhere public. Before deleting a branch, --delete exports it to
 * .release/backups/emdash-<production|staging>-<stamp>.db (git check-ignore must say the path is
 * ignored), then checks the file: size > 0, PRAGMA integrity_check = ok, and the ec_posts counts
 * (raw, active, published) equal the branch's. An existing local copy that passes the same checks is
 * kept and not exported again. If the export or any check fails, that branch is NOT deleted (an
 * existing copy that fails is left untouched) and the run exits non-zero.
 *
 * Output lists branch names, prefixes, ages and reasons only: never hostnames, URLs, the
 * organisation slug or tokens. Needs a Turso Platform API token (TURSO_PLATFORM_API_TOKEN,
 * TURSO_API_TOKEN or TF_VAR_turso_api_token; repo-root .env.dev is loaded when present) and the
 * organisation (TURSO_ORGANIZATION / TF_VAR_TURSO_ORGANIZATION).
 *
 * Usage (repo root):
 *   node scripts/turso-backup-retention.mjs                 # dry-run report
 *   node scripts/turso-backup-retention.mjs --json          # dry-run, JSON plan
 *   node scripts/turso-backup-retention.mjs --delete --expect-count 12   # operator only
 *   node scripts/turso-backup-retention.mjs --ci-staging-only --delete   # deploy-worker.yml staging job
 *   node scripts/turso-backup-retention.mjs --check-limit                # fail at >= 95 databases
 *
 * --ci-staging-only (#limit, 31 Oct 2026): the one mode allowed to delete on GitHub Actions. It only
 * ever considers staging-rollback-YYYYMMDD-HHMMSS branches (never prod-*, ci-*, staging-backup-*,
 * named or unstamped DBs), keeps the newest 10 whatever their age, deletes only branches older than
 * 7 days, skips the MSI export (staging copies are disposable; the repo is public, so CI never
 * writes a .db), and refuses to delete more than --max-delete (default 20) in one run.
 *
 * --check-limit: counts the organisation's databases and exits 4 at or above --limit-threshold
 * (default 95; the starter plan allows 100) with the operator command to free space. Used before
 * every Turso db-create in the backup scripts so the failure is clear instead of Turso's
 * "maximum database count" error mid-deploy.
 *
 * Old-style production checkpoints named prod-rollback-YYYYMMDD-HHMM (Apr-May 2026, no seconds)
 * are also matched, under every keep rule above.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export const TURSO_API_BASE = "https://api.turso.tech";
export const TURSO_HOST_HASH_DOMAIN = "freedomtimes-turso-host-v1:";
export const PRODUCTION_SITE = "https://freedomtimes.news";
export const STAGING_SITE = "https://staging.freedomtimes.news";
export const DEPLOY_PROVENANCE_PATH = "/api/deploy-provenance.json";

/** Hard floors: options below these are refused (production rollback safety). */
export const PRODUCTION_MIN_KEEP_NEWEST = 3;
export const PRODUCTION_MIN_KEEP_DAYS = 14;
export const STAGING_MIN_KEEP_NEWEST = 1;
/** Jon's policy (31 Oct 2026): no CI backup branch older than a month, above the count floors. */
export const DEFAULT_MAX_AGE_DAYS = 30;

/** Database-count guard (#limit): the Turso starter plan allows 100 databases. */
export const DEFAULT_DATABASE_LIMIT_THRESHOLD = 95;
/** --ci-staging-only: most branches one CI run may delete. */
export const DEFAULT_CI_MAX_DELETE = 20;
export const CI_STAGING_PREFIX = "staging-rollback-";
/** --ci-staging-only floors. Newest-N always holds. The age floor is pending Jon's decision
 *  (PR #176 thread 1): set CI_STAGING_MIN_KEEP_DAYS to 0 for a count-only CI policy. */
export const CI_STAGING_MIN_KEEP_NEWEST = 10;
export const CI_STAGING_MIN_KEEP_DAYS = 7;
export const DEFAULT_STAGING_DATABASE_NAME = "freedomtimes-emdash-staging";

export function isGithubActions(env = process.env) {
	return String(env.GITHUB_ACTIONS || "").toLowerCase() === "true";
}

/**
 * --ci-staging-only: the live staging target, by provenance hash match or by name
 * (TF_VAR_TURSO_DATABASE_NAME_STAGING, default freedomtimes-emdash-staging) present in the org.
 * @returns {{ identified: boolean, names: string[], note: string }}
 */
export function ciStagingTarget({ databases, env = {}, provenanceMatches = [] }) {
	const all = new Set(databases.map((db) => String(db.Name || db.name || "")));
	const configured = String(env.TF_VAR_TURSO_DATABASE_NAME_STAGING || "").trim() || DEFAULT_STAGING_DATABASE_NAME;
	const names = [...new Set([...provenanceMatches, ...(all.has(configured) ? [configured] : [])])];
	if (provenanceMatches.length) return { identified: true, names, note: "live staging provenance" };
	if (all.has(configured)) return { identified: true, names, note: `named ${configured}` };
	return { identified: false, names, note: `staging DB ${configured} not found in the organisation` };
}

/** @typedef {{ prefix: string, family: string, environment: "staging" | "production", keepNewest: number, keepDays: number, maxAgeDays: number, floorNewest: number, legacyMinuteStamp?: boolean }} RetentionRule */

/** @returns {RetentionRule[]} */
export function defaultRules({
	stagingKeepNewest = 10,
	stagingKeepDays = 7,
	productionKeepNewest = 5,
	productionKeepDays = 30,
	maxAgeDays = DEFAULT_MAX_AGE_DAYS,
} = {}) {
	if (maxAgeDays < PRODUCTION_MIN_KEEP_DAYS) {
		throw new Error(`--max-age-days must be at least ${PRODUCTION_MIN_KEEP_DAYS}.`);
	}
	if (productionKeepNewest < PRODUCTION_MIN_KEEP_NEWEST) {
		throw new Error(`--prod-keep-newest must be at least ${PRODUCTION_MIN_KEEP_NEWEST}.`);
	}
	if (productionKeepDays < PRODUCTION_MIN_KEEP_DAYS) {
		throw new Error(`--prod-keep-days must be at least ${PRODUCTION_MIN_KEEP_DAYS}.`);
	}
	if (stagingKeepNewest < STAGING_MIN_KEEP_NEWEST) {
		throw new Error(`--staging-keep-newest must be at least ${STAGING_MIN_KEEP_NEWEST}.`);
	}
	if (stagingKeepDays < 0) {
		throw new Error("--staging-keep-days cannot be negative.");
	}
	const staging = { environment: "staging", keepNewest: stagingKeepNewest, keepDays: stagingKeepDays, maxAgeDays, floorNewest: STAGING_MIN_KEEP_NEWEST };
	const production = { environment: "production", keepNewest: productionKeepNewest, keepDays: productionKeepDays, maxAgeDays, floorNewest: PRODUCTION_MIN_KEEP_NEWEST };
	// family: prefixes counted together for keep-newest / floors / newest-production. Jon's naming
	// (31 Oct 2026): new backups are prod-rollback-<stamp> / staging-rollback-<stamp>; the older
	// prod-backup-* / staging-backup-* (and legacy prod-rollback-* checkpoints) are the same backups.
	const prodFamily = "prod-rollback-*/prod-backup-*";
	const stagingFamily = "staging-rollback-*/staging-backup-*";
	return [
		{ prefix: "staging-rollback-", family: stagingFamily, ...staging },
		{ prefix: "staging-backup-", family: stagingFamily, ...staging },
		{ prefix: "ci-staging-backup-", family: "ci-staging-backup-*", ...staging },
		{ prefix: "prod-rollback-", family: prodFamily, ...production, legacyMinuteStamp: true },
		{ prefix: "prod-backup-", family: prodFamily, ...production },
		{ prefix: "ci-rollback-", family: "ci-rollback-*", ...production },
	];
}

/**
 * Rules for --ci-staging-only: staging-rollback-<stamp> only, newest 10 always kept (no maximum
 * age), delete only when older than 7 days. Nothing else is ever in scope.
 * @returns {RetentionRule[]}
 */
export function ciStagingOnlyRules({ stagingKeepNewest = CI_STAGING_MIN_KEEP_NEWEST, stagingKeepDays = CI_STAGING_MIN_KEEP_DAYS } = {}) {
	if (!Number.isInteger(stagingKeepNewest) || stagingKeepNewest < CI_STAGING_MIN_KEEP_NEWEST) {
		throw new Error("--ci-staging-only keeps at least the newest 10 staging-rollback branches.");
	}
	if (!Number.isInteger(stagingKeepDays) || stagingKeepDays < CI_STAGING_MIN_KEEP_DAYS) {
		throw new Error(`--ci-staging-only deletes nothing younger than ${CI_STAGING_MIN_KEEP_DAYS} days.`);
	}
	return [{
		prefix: CI_STAGING_PREFIX,
		family: "staging-rollback-*",
		environment: "staging",
		keepNewest: stagingKeepNewest,
		keepDays: stagingKeepDays,
		maxAgeDays: Infinity,
		floorNewest: stagingKeepNewest,
	}];
}

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
/** Old-style prod-rollback-YYYYMMDD-HHMM (no seconds), only for rules with legacyMinuteStamp. */
const LEGACY_MINUTE_STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/;

function stampMatch(rest, rule) {
	const m = STAMP_RE.exec(rest);
	if (m) return m.slice(1).map(Number);
	if (rule.legacyMinuteStamp) {
		const l = LEGACY_MINUTE_STAMP_RE.exec(rest);
		if (l) return [...l.slice(1).map(Number), 0];
	}
	return null;
}

/**
 * The rule a database name belongs to, or null. The rest of the name after the prefix must be
 * exactly a YYYYMMDD-HHMMSS stamp, so e.g. prod-backup-manual or prod-rollback-pre-x never match.
 * @param {string} name
 * @param {RetentionRule[]} rules
 */
export function matchRule(name, rules) {
	const n = String(name || "");
	for (const rule of rules) {
		if (n.startsWith(rule.prefix) && stampMatch(n.slice(rule.prefix.length), rule)) {
			return rule;
		}
	}
	return null;
}

/** UTC Date from a name's YYYYMMDD-HHMMSS stamp, or null when invalid. */
export function parseNameStamp(name, rule) {
	const m = stampMatch(String(name).slice(rule.prefix.length), rule);
	if (!m) return null;
	const [y, mo, d, h, mi, s] = m;
	const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
	if (
		date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d ||
		date.getUTCHours() !== h || date.getUTCMinutes() !== mi || date.getUTCSeconds() !== s
	) {
		return null;
	}
	return date;
}

/** Lower-cased hostname of a libsql/https URL (same rules as web/src/lib/deploy-provenance.ts). */
export function libsqlHostname(url) {
	if (typeof url !== "string" || url.trim() === "") return "";
	let host = url.trim().replace(/^libsql:\/\//i, "").replace(/^https:\/\//i, "");
	host = host.split("?")[0] ?? "";
	const at = host.lastIndexOf("@");
	if (at >= 0) host = host.slice(at + 1);
	return host.replace(/\/+$/, "").toLowerCase();
}

/** Same hash the Worker publishes as tursoHostSha256. */
export function tursoHostHash(host) {
	const normalized = String(host || "").trim().toLowerCase();
	if (!normalized) return null;
	return createHash("sha256").update(`${TURSO_HOST_HASH_DOMAIN}${normalized}`).digest("hex");
}

/**
 * Host forms a database can be reached at: the API Hostname, plus `{name}-{org}.{region}.turso.io`
 * and `{name}-{org}.turso.io` in case the API returns the other form.
 */
export function candidateHosts(db, organization) {
	const out = new Set();
	const h = String(db.Hostname || db.hostname || "").trim().toLowerCase();
	if (h) out.add(h);
	const name = String(db.Name || db.name || "").trim().toLowerCase();
	const org = String(organization || "").trim().toLowerCase();
	if (name && org) {
		out.add(`${name}-${org}.turso.io`);
		const region = String(db.primaryRegion || "").trim().toLowerCase();
		if (region) out.add(`${name}-${org}.${region}.turso.io`);
	}
	return [...out];
}

/**
 * Names of databases whose host hash equals `hash` (normally zero or one).
 * @param {Array<object>} databases
 */
export function databasesMatchingHostHash(databases, hash, organization) {
	if (!hash) return [];
	const want = String(hash).toLowerCase();
	return databases
		.filter((db) => candidateHosts(db, organization).some((h) => tursoHostHash(h) === want))
		.map((db) => String(db.Name || db.name));
}

/** Database names referenced by libsql URLs (host `{name}-{org}...`). */
export function databasesMatchingUrls(databases, urls, organization) {
	const hosts = new Set(urls.map(libsqlHostname).filter(Boolean));
	if (hosts.size === 0) return [];
	return databases
		.filter((db) => candidateHosts(db, organization).some((h) => hosts.has(h)))
		.map((db) => String(db.Name || db.name));
}

function readJsonFiles(dir) {
	if (!dir || !existsSync(dir)) return [];
	const out = [];
	for (const f of readdirSync(dir)) {
		if (!f.toLowerCase().endsWith(".json") || f.startsWith("_tmp")) continue;
		try {
			out.push({ file: f, data: JSON.parse(readFileSync(path.join(dir, f), "utf8").replace(/^\uFEFF/, "")) });
		} catch {
			// unreadable metadata is ignored (it can only add protection, never remove it)
		}
	}
	return out;
}

/**
 * Local evidence of verified / last-deploy backups.
 * Returns { newestVerified: string|null, lastReferenced: string|null } from
 * .release/rollback-branches/*.json (backupDatabase) and freedomtimes-agents data/backups/*.json
 * (destination.tursoBranch), ordered by createdAtUtc (falls back to the file name).
 */
export function protectedFromBackupRecords(records) {
	const rows = [];
	for (const { file, data } of records) {
		if (!data || typeof data !== "object") continue;
		const name = String(data.backupDatabase || data.destination?.tursoBranch || data.rollbackDatabase || "").trim();
		if (!name) continue;
		const created = Date.parse(String(data.createdAtUtc || ""));
		rows.push({ file, name, verified: data.verificationPass === true, at: Number.isFinite(created) ? created : 0 });
	}
	rows.sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
	return {
		newestVerified: rows.find((r) => r.verified)?.name ?? null,
		lastReferenced: rows[0]?.name ?? null,
	};
}

/**
 * Pure retention plan.
 * @param {{ databases: Array<object>, rules: RetentionRule[], now: Date,
 *   protect?: Map<string, string[]> }} input  protect: name -> reasons
 */
export function planRetention({ databases, rules, now, protect = new Map() }) {
	const entries = [];
	for (const db of databases) {
		const name = String(db.Name || db.name || "");
		const rule = matchRule(name, rules);
		if (!rule) continue;
		let created = parseNameStamp(name, rule);
		let createdSource = "name";
		const branchedAt = Date.parse(String(db.parent?.branched_at || ""));
		if (Number.isFinite(branchedAt)) {
			created = new Date(branchedAt);
			createdSource = "branched_at";
		}
		const ageDays = created ? (now.getTime() - created.getTime()) / 86_400_000 : null;
		entries.push({
			name,
			prefix: rule.prefix,
			environment: rule.environment,
			createdUtc: created ? created.toISOString() : null,
			createdSource,
			ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10,
			deleteProtection: db.delete_protection === true,
			reasons: [...(protect.get(name) ?? [])],
			action: "keep",
		});
	}

	const families = new Map();
	for (const rule of rules) if (!families.has(rule.family ?? rule.prefix)) families.set(rule.family ?? rule.prefix, rule);
	for (const [family, rule] of families) {
		const prefixes = new Set(rules.filter((r) => (r.family ?? r.prefix) === family).map((r) => r.prefix));
		const group = entries
			.filter((e) => prefixes.has(e.prefix))
			.sort((a, b) => (b.createdUtc ?? "9").localeCompare(a.createdUtc ?? "9") || b.name.localeCompare(a.name));
		group.forEach((e, i) => {
			if (e.deleteProtection) e.reasons.push("Turso delete protection is on");
			if (e.ageDays === null) e.reasons.push("age unknown");
			if (i < rule.floorNewest) e.reasons.push(`floor: newest ${rule.floorNewest} ${family}`);
			if (prefixes.has("prod-rollback-") && i === 0) e.reasons.push(`newest ${family} (last deploy rollback target)`);
			// Count/age keeps below yield to the maximum age; the reasons above (and --protect,
			// live Worker DBs, newest verified / referenced backups) never do.
			const overMaxAge = e.ageDays !== null && rule.maxAgeDays !== undefined && e.ageDays > rule.maxAgeDays;
			if (!overMaxAge) {
				if (i < rule.keepNewest) e.reasons.push(`newest ${rule.keepNewest} ${family}`);
				if (e.ageDays !== null && e.ageDays < rule.keepDays) e.reasons.push(`younger than ${rule.keepDays}d`);
			}
			if (e.reasons.length === 0) {
				e.action = "delete";
				e.reasons.push(
					overMaxAge
						? `older than the ${rule.maxAgeDays}d maximum age and above the floor of ${rule.floorNewest}`
						: `older than ${rule.keepDays}d and not among newest ${rule.keepNewest}`,
				);
			}
		});
	}
	return entries.sort((a, b) => a.prefix.localeCompare(b.prefix) || (b.createdUtc ?? "").localeCompare(a.createdUtc ?? ""));
}

/** Per-prefix counts and age ranges. */
export function summarisePlan(entries, rules) {
	return rules.map((rule) => {
		const g = entries.filter((e) => e.prefix === rule.prefix);
		const ages = g.map((e) => e.ageDays).filter((a) => a !== null);
		const del = g.filter((e) => e.action === "delete");
		const delAges = del.map((e) => e.ageDays).filter((a) => a !== null);
		return {
			prefix: rule.prefix,
			environment: rule.environment,
			policy: `${rule.family && rule.family !== `${rule.prefix}*` ? `counted with ${rule.family}: ` : ""}keep newest ${rule.keepNewest} and anything younger than ${rule.keepDays}d; nothing older than ${rule.maxAgeDays}d beyond the newest ${rule.floorNewest}`,
			total: g.length,
			keep: g.length - del.length,
			wouldDelete: del.length,
			newestAgeDays: ages.length ? Math.min(...ages) : null,
			oldestAgeDays: ages.length ? Math.max(...ages) : null,
			deleteAgeRangeDays: delAges.length ? [Math.min(...delAges), Math.max(...delAges)] : null,
		};
	});
}

/** --protect names that are not databases in the organisation. */
export function unmatchedProtectNames(protectNames, databases) {
	const names = new Set(databases.map((db) => String(db.Name || db.name || "")));
	return [...new Set(protectNames)].filter((n) => !names.has(n));
}

/** Checks --delete must pass. Returns a list of refusal reasons (empty = allowed). */
export function deleteRefusals({
	plan,
	expectCount,
	env = process.env,
	liveProduction,
	liveStaging,
	allowUnverifiedStaging = false,
	unmatchedProtect = [],
	ciStagingOnly = false,
	maxDelete = DEFAULT_CI_MAX_DELETE,
}) {
	const out = [];
	const toDelete = plan.filter((e) => e.action === "delete");
	if (ciStagingOnly) {
		return ciStagingDeleteRefusals({ plan, maxDelete, unmatchedProtect, liveStaging });
	}
	if (String(env.GITHUB_ACTIONS || "").toLowerCase() === "true") {
		out.push("deletion is never run on GitHub Actions (report only in CI)");
	}
	if (!Number.isInteger(expectCount)) {
		out.push("--delete needs --expect-count N (the number of branches the dry-run listed)");
	} else if (expectCount !== toDelete.length) {
		out.push(`--expect-count ${expectCount} does not match the plan (${toDelete.length} to delete); re-run the dry-run`);
	}
	if (!liveProduction?.identified) {
		out.push("the live production Worker's database was not identified among the organisation's databases");
	}
	if (toDelete.some((e) => e.environment === "staging") && !liveStaging?.identified && !allowUnverifiedStaging) {
		out.push(
			"the live staging Worker's database was not identified (needed before deleting staging branches; " +
				"staging is behind the Auth0 lock, so pass --allow-unverified-staging to accept that)",
		);
	}
	for (const name of unmatchedProtect) {
		out.push(`--protect ${name} is not a database in the organisation (typo?)`);
	}
	return out;
}

/** True only for a name --ci-staging-only may ever delete: staging-rollback-YYYYMMDD-HHMMSS. */
export function isCiStagingCandidate(name) {
	const n = String(name || "");
	return n.startsWith(CI_STAGING_PREFIX) && STAMP_RE.test(n.slice(CI_STAGING_PREFIX.length));
}

/** Checks --ci-staging-only --delete must pass (allowed on GitHub Actions). */
export function ciStagingDeleteRefusals({ plan, maxDelete = DEFAULT_CI_MAX_DELETE, unmatchedProtect = [], liveStaging }) {
	const out = [];
	if (!liveStaging?.identified) {
		out.push(`the live staging target was not identified (${liveStaging?.note || "unknown"}); --ci-staging-only deletes nothing`);
	}
	const toDelete = plan.filter((e) => e.action === "delete");
	for (const e of toDelete) {
		if (!isCiStagingCandidate(e.name) || e.environment !== "staging" || e.prefix !== CI_STAGING_PREFIX) {
			out.push(`${e.name} is not a staging-rollback-<stamp> branch; --ci-staging-only never deletes it`);
		}
	}
	if (!Number.isInteger(maxDelete) || maxDelete < 0) {
		out.push("--max-delete needs a non-negative integer");
	} else if (toDelete.length > maxDelete) {
		out.push(`plan deletes ${toDelete.length} branches, above --max-delete ${maxDelete}; run the operator mode on the MSI`);
	}
	for (const name of unmatchedProtect) {
		out.push(`--protect ${name} is not a database in the organisation (typo?)`);
	}
	return out;
}

/**
 * Database-count guard before a Turso db-create.
 * @returns {{ ok: boolean, count: number, threshold: number, message: string }}
 */
export function databaseLimitCheck(count, threshold = DEFAULT_DATABASE_LIMIT_THRESHOLD) {
	if (!Number.isInteger(count) || count < 0) throw new Error("database count must be a non-negative integer");
	if (!Number.isInteger(threshold) || threshold < 1) throw new Error("--limit-threshold needs a positive integer");
	if (count < threshold) {
		return { ok: true, count, threshold, message: `Turso databases: ${count} (limit check threshold ${threshold}); OK to create a backup branch.` };
	}
	return {
		ok: false,
		count,
		threshold,
		message:
			`Turso database count ${count} is at or above ${threshold} (plan limit 100): a new backup branch would fail. ` +
			"Jon: on the MSI run `node scripts/turso-backup-retention.mjs` (dry-run), then " +
			"`node scripts/turso-backup-retention.mjs --delete --expect-count N` with N from the dry-run. Nothing was created.",
	};
}

function parseArgs(argv) {
	const out = {
		json: false,
		delete: false,
		allowUnverifiedStaging: false,
		expectCount: undefined,
		ciStagingOnly: false,
		maxDelete: DEFAULT_CI_MAX_DELETE,
		checkLimit: false,
		limitThreshold: DEFAULT_DATABASE_LIMIT_THRESHOLD,
		protect: [],
		agentsDir: path.resolve(repoRoot, "..", "freedomtimes-agents"),
		metadataDir: path.join(repoRoot, ".release", "rollback-branches"),
		backupsDir: path.join(repoRoot, ".release", "backups"),
		productionSite: PRODUCTION_SITE,
		stagingSite: STAGING_SITE,
		rules: {},
	};
	const num = (v, flag) => {
		const n = Number(v);
		if (!Number.isInteger(n)) throw new Error(`${flag} needs an integer.`);
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
			return argv[++i];
		};
		if (a === "--json") out.json = true;
		else if (a === "--delete") out.delete = true;
		else if (a === "--allow-unverified-staging") out.allowUnverifiedStaging = true;
		else if (a === "--expect-count") out.expectCount = num(next(), a);
		else if (a === "--ci-staging-only") out.ciStagingOnly = true;
		else if (a === "--max-delete") out.maxDelete = num(next(), a);
		else if (a === "--check-limit") out.checkLimit = true;
		else if (a === "--limit-threshold") out.limitThreshold = num(next(), a);
		else if (a === "--protect") out.protect.push(next());
		else if (a === "--agents-dir") out.agentsDir = path.resolve(next());
		else if (a === "--metadata-dir") out.metadataDir = path.resolve(next());
		else if (a === "--production-site") out.productionSite = next();
		else if (a === "--staging-site") out.stagingSite = next();
		else if (a === "--staging-keep-newest") out.rules.stagingKeepNewest = num(next(), a);
		else if (a === "--staging-keep-days") out.rules.stagingKeepDays = num(next(), a);
		else if (a === "--prod-keep-newest") out.rules.productionKeepNewest = num(next(), a);
		else if (a === "--prod-keep-days") out.rules.productionKeepDays = num(next(), a);
		else if (a === "--max-age-days") out.rules.maxAgeDays = num(next(), a);
		else if (a === "--help" || a === "-h") {
			out.help = true;
		} else {
			throw new Error(`Unknown argument ${a} (see --help).`);
		}
	}
	return out;
}

const HELP = `Usage: node scripts/turso-backup-retention.mjs [options]
Dry-run by default: lists CI backup branches with ages and what the policy would delete.
  --json                     Print the plan as JSON (names, prefixes, ages, reasons only)
  --protect NAME             Never delete NAME (repeatable; e.g. a branch named in an incident)
  --staging-keep-newest N    Default 10 (min ${STAGING_MIN_KEEP_NEWEST})
  --staging-keep-days N      Default 7
  --prod-keep-newest N       Default 5 (min ${PRODUCTION_MIN_KEEP_NEWEST})
  --prod-keep-days N         Default 30 (min ${PRODUCTION_MIN_KEEP_DAYS})
  --max-age-days N           Default ${DEFAULT_MAX_AGE_DAYS} (min ${PRODUCTION_MIN_KEEP_DAYS}): older branches go even when a keep-newest
                             rule would keep them, down to the floors (newest ${PRODUCTION_MIN_KEEP_NEWEST} production,
                             ${STAGING_MIN_KEEP_NEWEST} staging per prefix). Always-kept branches stay.
  --agents-dir PATH          freedomtimes-agents checkout (default ../freedomtimes-agents)
  --metadata-dir PATH        Default .release/rollback-branches
  --delete --expect-count N  Operator only: delete exactly the N branches the dry-run listed.
                             Refused on GitHub Actions, when the live Worker DBs are not identified,
                             and while a --protect name is not a database in the organisation.
                             Each branch is first exported to .release/backups/emdash-<env>-<stamp>.db
                             (must be gitignored) and checked (size, integrity_check, post counts);
                             a branch whose copy fails is kept (exit 3). Needs the Turso CLI
                             (WSL on Windows) and web/node_modules.
  --allow-unverified-staging With --delete: allow staging branches to go when the staging Worker's
                             provenance cannot be read (Auth0 lock). Production has no such switch.
  --ci-staging-only          Only staging-rollback-<stamp>: keep newest 10, delete only those older than
                             7 days, no local export. With --delete this is the one mode allowed on
                             GitHub Actions; refused above --max-delete N (default ${DEFAULT_CI_MAX_DELETE}).
  --check-limit              Count the organisation's databases; exit 4 at or above --limit-threshold N
                             (default ${DEFAULT_DATABASE_LIMIT_THRESHOLD}). Deletes nothing.`;

/** Local .db path for a branch: .release/backups/emdash-<production|staging>-<stamp>.db */
export function localBackupPath(entry, backupsDir) {
	const stamp = entry.name.slice(entry.prefix.length);
	if (!/^\d{8}-\d{4}(\d{2})?$/.test(stamp)) throw new Error(`unexpected backup branch name ${entry.name}`);
	return path.join(backupsDir, `emdash-${entry.environment}-${stamp}.db`);
}

function sameCounts(a, b) {
	return a && b && a.raw === b.raw && a.active === b.active && a.published === b.published;
}

function fmtCounts(c) {
	return c ? `raw ${c.raw}, active ${c.active}, published ${c.published}` : "?";
}

/**
 * Make sure a verified local .db copy of the branch exists before it is deleted.
 * deps: isIgnored(path), exists(path), size(path), exportBranch(name, outPath),
 *       fileCheck(path) -> { integrity: string, counts }, branchCounts(name) -> counts,
 *       rename(from, to), remove(path).
 * @returns {Promise<{ ok: boolean, action: "existing" | "exported" | "skipped", file: string, detail: string }>}
 */
export async function ensureLocalCopy(entry, backupsDir, deps) {
	const file = localBackupPath(entry, backupsDir);
	const rel = path.basename(file);
	const fail = (detail) => ({ ok: false, action: "skipped", file: rel, detail });
	try {
		if (!deps.isIgnored(file) || !deps.isIgnored(`${file}.partial`)) return fail(`${rel} is not gitignored; refusing to write a backup there`);
		const check = async (p) => {
			if (!deps.exists(p) || !(deps.size(p) > 0)) return "file missing or empty";
			const f = await deps.fileCheck(p);
			if (String(f.integrity).toLowerCase() !== "ok") return `integrity_check: ${String(f.integrity).slice(0, 80)}`;
			const b = await deps.branchCounts(entry.name);
			if (!sameCounts(f.counts, b)) return `post counts differ (file ${fmtCounts(f.counts)}; branch ${fmtCounts(b)})`;
			return "";
		};
		if (deps.exists(file)) {
			const problem = await check(file);
			if (problem) return fail(`existing ${rel} does not verify (${problem}); left untouched`);
			return { ok: true, action: "existing", file: rel, detail: "existing local copy verified" };
		}
		const partial = `${file}.partial`;
		if (deps.exists(partial)) deps.remove(partial);
		try {
			await deps.exportBranch(entry.name, partial);
		} catch (err) {
			if (deps.exists(partial)) deps.remove(partial);
			return fail(`export failed (${err?.message || err})`);
		}
		let problem;
		try {
			problem = await check(partial);
		} catch (err) {
			problem = `local copy check failed: ${err?.message || err}`;
		}
		if (problem) {
			if (deps.exists(partial)) deps.remove(partial);
			return fail(`export did not verify (${problem})`);
		}
		deps.rename(partial, file);
		return { ok: true, action: "exported", file: rel, detail: "exported and verified" };
	} catch (err) {
		return fail(`local copy check failed (${err?.message || err})`);
	}
}

/**
 * Delete each branch only after ensureLocalCopy succeeded for it.
 * @returns {Promise<{ deleted: object[], skipped: object[] }>}
 */
export async function deleteWithLocalCopies(toDelete, { ensure, del, log = () => {} }) {
	const deleted = [];
	const skipped = [];
	for (const e of toDelete) {
		const copy = await ensure(e);
		if (!copy.ok) {
			skipped.push({ name: e.name, ageDays: e.ageDays, file: copy.file, detail: copy.detail });
			log(`NOT deleted ${e.name} (${fmtAge(e.ageDays)}): ${copy.detail}`);
			continue;
		}
		await del(e.name);
		deleted.push({ name: e.name, ageDays: e.ageDays, file: copy.file, copy: copy.action });
		log(`Deleted ${e.name} (${fmtAge(e.ageDays)}); local copy ${copy.file} (${copy.detail})`);
	}
	return { deleted, skipped };
}

function shQuote(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Turso CLI (WSL on Windows, like backup-production-emdash.ps1). Returns the last stdout line. */
function tursoCli(args) {
	const r =
		process.platform === "win32"
			? spawnSync("wsl", ["bash", "-lc", `$HOME/.turso/turso ${args.map(shQuote).join(" ")}`], { encoding: "utf8" })
			: spawnSync("turso", args, { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`turso ${args[0]} ${args[1]} exited ${r.status ?? r.error?.code ?? "?"}`);
	const lines = String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	return lines.at(-1) ?? "";
}

function cliOutputPath(p) {
	if (process.platform !== "win32") return p;
	// Same form as backup-production-emdash.ps1: wsl bash -lc "wslpath -a '<path>'" (a bare
	// `wsl wslpath C:\\...` loses the backslashes in WSL's command line).
	const r = spawnSync("wsl", ["bash", "-lc", `wslpath -a ${shQuote(p)}`], { encoding: "utf8" });
	const out = String(r.stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
	if (r.status !== 0 || !out) throw new Error("wslpath failed for the output file");
	return out;
}

export async function realLocalCopyDeps() {
	const lib = path.join(repoRoot, "web", "scripts", "lib", "production-emdash-inventory.mjs");
	const { countPostInventory, openLibsql, openSqliteReadonly } = await import(pathToFileURL(lib).href);
	return {
		isIgnored: (p) => spawnSync("git", ["check-ignore", "-q", "--", path.relative(repoRoot, p)], { cwd: repoRoot }).status === 0,
		exists: (p) => existsSync(p),
		size: (p) => statSync(p).size,
		rename: (a, b) => renameSync(a, b),
		remove: (p) => rmSync(p, { force: true }),
		exportBranch: async (name, outPath) => {
			// .release/backups/ may not exist on a fresh checkout (git-ignored; checked above).
			mkdirSync(path.dirname(outPath), { recursive: true });
			tursoCli(["db", "export", name, "--output-file", cliOutputPath(outPath)]);
		},
		fileCheck: async (p) => {
			const c = openSqliteReadonly(p);
			try {
				const rows = (await c.execute("PRAGMA integrity_check")).rows;
				const integrity = rows.map((r) => String(r[0] ?? r.integrity_check)).join("; ");
				return { integrity, counts: await countPostInventory(c) };
			} finally {
				c.close?.();
			}
		},
		branchCounts: async (name) => {
			const url = tursoCli(["db", "show", name, "--url"]);
			if (!/^libsql:\/\//.test(url)) throw new Error(`could not read the URL of ${name}`);
			// Read-only, 1-day token from the Turso CLI (as backup-production-emdash.ps1 does); never printed.
			let token = tursoCli(["db", "tokens", "create", name, "--read-only", "--expiration", "1d"]);
			const c = openLibsql(url, token);
			token = "";
			try {
				return await countPostInventory(c);
			} finally {
				c.close?.();
			}
		},
	};
}

function platformToken(env) {
	for (const k of ["TURSO_PLATFORM_API_TOKEN", "TURSO_API_TOKEN", "TF_VAR_turso_api_token"]) {
		const v = String(env[k] || "").trim();
		if (v) return v;
	}
	return "";
}

function organization(env) {
	for (const k of ["TURSO_ORGANIZATION", "TURSO_ORG", "TF_VAR_TURSO_ORGANIZATION", "TF_VAR_turso_organization"]) {
		const v = String(env[k] || "").trim();
		if (v) return v.toLowerCase();
	}
	return "";
}

/** Side effects main() uses; run() swaps them for tests. */
let io = { fetch: (...a) => globalThis.fetch(...a), out: (...a) => console.log(...a), err: (...a) => console.error(...a) };

/**
 * Testable entry point: run(argv, { env, fetch, out, err, loadEnvDev }) -> exit code.
 * loadEnvDev defaults to false here (tests); the CLI entry loads repo-root .env.dev.
 */
export async function run(argv, { env = process.env, fetch, out, err, loadEnvDev = false } = {}) {
	const prev = io;
	io = { fetch: fetch ?? prev.fetch, out: out ?? prev.out, err: err ?? prev.err };
	try {
		return await main(argv, { env, loadEnvDev });
	} finally {
		io = prev;
	}
}

async function listDatabases(org, token) {
	const res = await io.fetch(`${TURSO_API_BASE}/v1/organizations/${encodeURIComponent(org)}/databases`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`Turso Platform API list databases failed (HTTP ${res.status}).`);
	const body = await res.json();
	if (!Array.isArray(body?.databases)) throw new Error("Turso Platform API returned no databases array.");
	return body.databases;
}

async function deleteDatabase(org, token, name) {
	const res = await io.fetch(
		`${TURSO_API_BASE}/v1/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(name)}`,
		{ method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) throw new Error(`delete ${name} failed (HTTP ${res.status}).`);
}

async function liveHostHash(site, env) {
	const headers = { Accept: "application/json" };
	const t = String(env.DEPLOY_PROVENANCE_TOKEN || "").trim();
	if (t) headers.Authorization = `Bearer ${t}`;
	try {
		const res = await io.fetch(new URL(DEPLOY_PROVENANCE_PATH, site), { headers, redirect: "manual" });
		if (!res.ok) return { hash: null, note: `provenance HTTP ${res.status}` };
		const body = await res.json();
		const hash = typeof body?.tursoHostSha256 === "string" ? body.tursoHostSha256.toLowerCase() : null;
		return { hash, note: hash ? "ok" : "provenance has no tursoHostSha256" };
	} catch (err) {
		return { hash: null, note: `provenance unreachable (${err?.name || "error"})` };
	}
}

function addProtect(map, name, reason) {
	if (!name) return;
	if (!map.has(name)) map.set(name, []);
	if (!map.get(name).includes(reason)) map.get(name).push(reason);
}

function fmtAge(a) {
	return a === null ? "?" : `${a.toFixed(1)}d`;
}

async function main(argv, { env = process.env, loadEnvDev: loadDev = true } = {}) {
	const opts = parseArgs(argv);
	if (opts.help) {
		io.out(HELP);
		return 0;
	}
	const envDev = path.join(repoRoot, "web", "scripts", "lib", "load-env-dev.mjs");
	if (loadDev && existsSync(envDev)) {
		const { loadEnvDev } = await import(pathToFileURL(envDev).href);
		loadEnvDev(path.join(repoRoot, ".env.dev"));
	}
	const token = platformToken(env);
	const org = organization(env);
	if (opts.checkLimit) {
		if (!token || !org) {
			if (isGithubActions(env)) {
				// AGENTS.md §6: never silently skip on CI (a renamed secret/var would disable the guard).
				io.err("turso-backup-retention --check-limit: no Turso Platform API token or organisation on GitHub Actions; failing closed. Set TURSO_API_TOKEN and TF_VAR_TURSO_ORGANIZATION for this step.");
				return 1;
			}
			io.err("turso-backup-retention --check-limit: no Turso Platform API token or organisation in the environment; database count not checked (local session).");
			return 0;
		}
		const r = databaseLimitCheck((await listDatabases(org, token)).length, opts.limitThreshold);
		(r.ok ? io.out : io.err)(r.message);
		return r.ok ? 0 : 4;
	}
	if (opts.ciStagingOnly && Object.keys(opts.rules).some((k) => !["stagingKeepNewest", "stagingKeepDays"].includes(k))) {
		throw new Error("--ci-staging-only takes only --staging-keep-newest / --staging-keep-days rule options.");
	}
	const rules = opts.ciStagingOnly ? ciStagingOnlyRules(opts.rules) : defaultRules(opts.rules);
	if (!token) throw new Error("No Turso Platform API token (TURSO_PLATFORM_API_TOKEN / TURSO_API_TOKEN / TF_VAR_turso_api_token).");
	if (!org) throw new Error("No Turso organisation (TURSO_ORGANIZATION / TF_VAR_TURSO_ORGANIZATION).");

	const databases = await listDatabases(org, token);
	const protect = new Map();

	for (const name of opts.protect) addProtect(protect, name, "--protect");
	const unmatchedProtect = unmatchedProtectNames(opts.protect, databases);

	const prodLive = await liveHostHash(opts.productionSite, env);
	const stagingLive = await liveHostHash(opts.stagingSite, env);
	const prodMatches = databasesMatchingHostHash(databases, prodLive.hash, org);
	const stagingMatches = databasesMatchingHostHash(databases, stagingLive.hash, org);
	for (const n of prodMatches) addProtect(protect, n, "live production Worker DB");
	for (const n of stagingMatches) addProtect(protect, n, "live staging Worker DB");

	const urlKeys = Object.keys(env).filter((k) => /TURSO.*(DATABASE|DB)_URL$/i.test(k));
	for (const n of databasesMatchingUrls(databases, urlKeys.map((k) => env[k]), org)) {
		addProtect(protect, n, "named by a TURSO_*_URL in the environment");
	}

	const records = [
		...readJsonFiles(opts.metadataDir),
		...readJsonFiles(path.join(opts.agentsDir, "data", "backups")),
	];
	const evidence = protectedFromBackupRecords(records);
	addProtect(protect, evidence.newestVerified, "newest verified prod backup (local metadata / agents log)");
	addProtect(protect, evidence.lastReferenced, "named by the newest backup metadata (last local deploy)");

	let liveStaging = { identified: stagingMatches.length > 0, note: stagingLive.note };
	if (opts.ciStagingOnly) {
		const target = ciStagingTarget({ databases, env, provenanceMatches: stagingMatches });
		for (const n of target.names) addProtect(protect, n, "live staging target (--ci-staging-only)");
		liveStaging = { identified: target.identified, note: `${target.note}; provenance: ${stagingLive.note}` };
	}
	const plan = planRetention({ databases, rules, now: new Date(), protect });
	const summary = summarisePlan(plan, rules);
	const liveProduction = { identified: prodMatches.length > 0, note: prodLive.note };
	const otherCount = databases.length - plan.length;

	if (opts.json) {
		io.out(JSON.stringify({
			mode: `${opts.ciStagingOnly ? "ci-staging-only " : ""}${opts.delete ? "delete" : "dry-run"}`,
			databasesInOrganisation: databases.length,
			notInScope: otherCount,
			liveProduction,
			liveStaging,
			localBackupRecords: records.length,
			unmatchedProtect,
			summary,
			plan,
		}, null, 2));
	} else {
		io.out(`Turso backup retention (${opts.delete ? "DELETE" : "dry-run"})`);
		io.out(`Databases in organisation: ${databases.length} (${otherCount} not CI backup branches; never touched)`);
		io.out(`Live production Worker DB identified: ${liveProduction.identified ? "yes" : "no"} (${liveProduction.note})`);
		io.out(`Live staging Worker DB identified: ${liveStaging.identified ? "yes" : "no"} (${liveStaging.note})`);
		io.out(`Local backup records read: ${records.length}`);
		for (const n of unmatchedProtect) io.out(`WARNING: --protect ${n} is not a database in the organisation (typo?)`);
		for (const s of summary) {
			io.out(`\n${s.prefix}* [${s.environment}] ${s.policy}`);
			io.out(`  total ${s.total}, keep ${s.keep}, would delete ${s.wouldDelete}; ages ${fmtAge(s.newestAgeDays)} .. ${fmtAge(s.oldestAgeDays)}`);
			for (const e of plan.filter((p) => p.prefix === s.prefix)) {
				const local =
					e.action === "delete"
						? existsSync(localBackupPath(e, opts.backupsDir))
							? "  [local .db present; checked before delete, branch kept if it does not verify]"
							: "  [no local .db yet; exported before delete]"
						: "";
				io.out(`  ${e.action === "delete" ? "DELETE" : "keep  "}  ${e.name}  ${fmtAge(e.ageDays)}  ${e.reasons.join("; ")}${local}`);
			}
		}
	}

	const toDelete = plan.filter((e) => e.action === "delete");
	if (!opts.delete) {
		io.err(`\nDry-run: ${toDelete.length} branch(es) would be deleted. Nothing was deleted.`);
		return 0;
	}
	const refusals = deleteRefusals({
		plan,
		expectCount: opts.expectCount,
		env,
		liveProduction,
		liveStaging,
		allowUnverifiedStaging: opts.allowUnverifiedStaging,
		unmatchedProtect,
		ciStagingOnly: opts.ciStagingOnly,
		maxDelete: opts.maxDelete,
	});
	if (refusals.length) {
		for (const r of refusals) io.err(`Refusing to delete: ${r}`);
		return 2;
	}
	if (opts.ciStagingOnly) {
		// Staging copies are disposable and CI never writes a .db (public repo): no export.
		let n = 0;
		for (const e of toDelete) {
			if (!isCiStagingCandidate(e.name)) throw new Error(`refusing ${e.name}`);
			await deleteDatabase(org, token, e.name);
			n++;
			io.err(`Deleted ${e.name} (${fmtAge(e.ageDays)}): ${e.reasons.join("; ")}`);
		}
		io.err(`--ci-staging-only: deleted ${n} staging-rollback branch(es).`);
		return 0;
	}
	if (opts.allowUnverifiedStaging && !liveStaging.identified && toDelete.some((e) => e.environment === "staging")) {
		io.err("WARNING: deleting staging branches without the staging Worker's provenance (--allow-unverified-staging).");
	}
	const backupsDir = opts.backupsDir;
	const deps = await realLocalCopyDeps();
	const { deleted, skipped } = await deleteWithLocalCopies(toDelete, {
		ensure: (e) => ensureLocalCopy(e, backupsDir, deps),
		del: (name) => deleteDatabase(org, token, name),
		log: (line) => io.err(line),
	});
	io.err(`Deleted ${deleted.length} branch(es); ${skipped.length} kept because the local copy failed.`);
	return skipped.length ? 3 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err) => {
			console.error(`turso-backup-retention: ${err?.message || err}`);
			process.exit(1);
		},
	);
}
