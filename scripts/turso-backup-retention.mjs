#!/usr/bin/env node
/**
 * Turso CI backup branch retention (#143). Dry-run by default.
 *
 * Every CI deploy creates a Turso database branch that nothing deletes:
 *   staging-backup-YYYYMMDD-HHMMSS      deploy-worker.yml staging job (every PR push)
 *   prod-backup-YYYYMMDD-HHMMSS         deploy-worker.yml production job / backup-production-emdash.ps1
 *   ci-staging-backup-YYYYMMDD-HHMMSS   legacy terraform-staging.yml mutate dispatch
 *   ci-rollback-YYYYMMDD-HHMMSS         legacy terraform-production.yml mutate dispatch
 * They count against the Turso plan's database/storage limits; at the limit the fail-closed
 * backup step (and so the deploy) fails. This script lists them with ages and says which ones
 * the policy would delete. It deletes nothing unless run with --delete --expect-count N.
 *
 * Only names that match one of the prefixes above **and** end in a YYYYMMDD-HHMMSS stamp are
 * candidates. Everything else is never touched: named DBs (freedomtimes-emdash-production,
 * freedomtimes-emdash-staging), DR targets, prod-rollback-* operator checkpoints, prod-work-*,
 * prod-recovery-*, anything unrecognised.
 *
 * Always kept (whatever the age):
 *   - the newest N branches of each prefix (staging 10, production 5) and anything younger than
 *     the minimum age (staging 7 days, production 30 days);
 *   - the newest prod-backup-* (the rollback target of the last deploy: every production deploy
 *     takes one before it migrates) and the newest *verified* prod-backup-* from local
 *     .release/rollback-branches/*.json metadata and freedomtimes-agents/data/backups/*.json logs,
 *     plus the branch the newest metadata file names (last local deploy/backup);
 *   - any branch the live production or staging Worker uses (matched by the host hash in
 *     /api/deploy-provenance.json, e.g. after a DR retarget to a backup branch);
 *   - any branch named by a libsql URL in the environment (TURSO_DATABASE_URL,
 *     TURSO_PRODUCTION_EMDASH_DB_URL, ...), Turso delete protection, or --protect NAME.
 *
 * --delete refuses to run on GitHub Actions, refuses unless the live production Worker's DB was
 * identified among the organisation's databases (and the staging one, if any staging branch would
 * be deleted), and refuses unless --expect-count equals the number of branches the plan deletes.
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
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** @typedef {{ prefix: string, environment: "staging" | "production", keepNewest: number, keepDays: number }} RetentionRule */

/** @returns {RetentionRule[]} */
export function defaultRules({
	stagingKeepNewest = 10,
	stagingKeepDays = 7,
	productionKeepNewest = 5,
	productionKeepDays = 30,
} = {}) {
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
	return [
		{ prefix: "staging-backup-", environment: "staging", keepNewest: stagingKeepNewest, keepDays: stagingKeepDays },
		{ prefix: "ci-staging-backup-", environment: "staging", keepNewest: stagingKeepNewest, keepDays: stagingKeepDays },
		{ prefix: "prod-backup-", environment: "production", keepNewest: productionKeepNewest, keepDays: productionKeepDays },
		{ prefix: "ci-rollback-", environment: "production", keepNewest: productionKeepNewest, keepDays: productionKeepDays },
	];
}

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/**
 * The rule a database name belongs to, or null. The rest of the name after the prefix must be
 * exactly a YYYYMMDD-HHMMSS stamp, so e.g. prod-backup-manual or prod-rollback-* never match.
 * @param {string} name
 * @param {RetentionRule[]} rules
 */
export function matchRule(name, rules) {
	const n = String(name || "");
	for (const rule of rules) {
		if (n.startsWith(rule.prefix) && STAMP_RE.test(n.slice(rule.prefix.length))) {
			return rule;
		}
	}
	return null;
}

/** UTC Date from a name's YYYYMMDD-HHMMSS stamp, or null when invalid. */
export function parseNameStamp(name, rule) {
	const m = STAMP_RE.exec(String(name).slice(rule.prefix.length));
	if (!m) return null;
	const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
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

	for (const rule of rules) {
		const group = entries
			.filter((e) => e.prefix === rule.prefix)
			.sort((a, b) => (b.createdUtc ?? "9").localeCompare(a.createdUtc ?? "9") || b.name.localeCompare(a.name));
		group.forEach((e, i) => {
			if (e.deleteProtection) e.reasons.push("Turso delete protection is on");
			if (e.ageDays === null) e.reasons.push("age unknown");
			if (i < rule.keepNewest) e.reasons.push(`newest ${rule.keepNewest} ${rule.prefix}*`);
			if (e.ageDays !== null && e.ageDays < rule.keepDays) e.reasons.push(`younger than ${rule.keepDays}d`);
			if (rule.prefix === "prod-backup-" && i === 0) e.reasons.push("newest prod-backup-* (last deploy rollback target)");
			if (e.reasons.length === 0) {
				e.action = "delete";
				e.reasons.push(`older than ${rule.keepDays}d and not among newest ${rule.keepNewest}`);
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
			policy: `keep newest ${rule.keepNewest} and anything younger than ${rule.keepDays}d`,
			total: g.length,
			keep: g.length - del.length,
			wouldDelete: del.length,
			newestAgeDays: ages.length ? Math.min(...ages) : null,
			oldestAgeDays: ages.length ? Math.max(...ages) : null,
			deleteAgeRangeDays: delAges.length ? [Math.min(...delAges), Math.max(...delAges)] : null,
		};
	});
}

/** Checks --delete must pass. Returns a list of refusal reasons (empty = allowed). */
export function deleteRefusals({ plan, expectCount, env = process.env, liveProduction, liveStaging }) {
	const out = [];
	const toDelete = plan.filter((e) => e.action === "delete");
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
	if (toDelete.some((e) => e.environment === "staging") && !liveStaging?.identified) {
		out.push("the live staging Worker's database was not identified (needed before deleting staging branches)");
	}
	return out;
}

function parseArgs(argv) {
	const out = {
		json: false,
		delete: false,
		expectCount: undefined,
		protect: [],
		agentsDir: path.resolve(repoRoot, "..", "freedomtimes-agents"),
		metadataDir: path.join(repoRoot, ".release", "rollback-branches"),
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
		else if (a === "--expect-count") out.expectCount = num(next(), a);
		else if (a === "--protect") out.protect.push(next());
		else if (a === "--agents-dir") out.agentsDir = path.resolve(next());
		else if (a === "--metadata-dir") out.metadataDir = path.resolve(next());
		else if (a === "--production-site") out.productionSite = next();
		else if (a === "--staging-site") out.stagingSite = next();
		else if (a === "--staging-keep-newest") out.rules.stagingKeepNewest = num(next(), a);
		else if (a === "--staging-keep-days") out.rules.stagingKeepDays = num(next(), a);
		else if (a === "--prod-keep-newest") out.rules.productionKeepNewest = num(next(), a);
		else if (a === "--prod-keep-days") out.rules.productionKeepDays = num(next(), a);
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
  --agents-dir PATH          freedomtimes-agents checkout (default ../freedomtimes-agents)
  --metadata-dir PATH        Default .release/rollback-branches
  --delete --expect-count N  Operator only: delete exactly the N branches the dry-run listed.
                             Refused on GitHub Actions and when the live Worker DBs are not identified.`;

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

async function listDatabases(org, token) {
	const res = await fetch(`${TURSO_API_BASE}/v1/organizations/${encodeURIComponent(org)}/databases`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) throw new Error(`Turso Platform API list databases failed (HTTP ${res.status}).`);
	const body = await res.json();
	if (!Array.isArray(body?.databases)) throw new Error("Turso Platform API returned no databases array.");
	return body.databases;
}

async function deleteDatabase(org, token, name) {
	const res = await fetch(
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
		const res = await fetch(new URL(DEPLOY_PROVENANCE_PATH, site), { headers, redirect: "manual" });
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

async function main(argv) {
	const opts = parseArgs(argv);
	if (opts.help) {
		console.log(HELP);
		return 0;
	}
	const envDev = path.join(repoRoot, "web", "scripts", "lib", "load-env-dev.mjs");
	if (existsSync(envDev)) {
		const { loadEnvDev } = await import(pathToFileURL(envDev).href);
		loadEnvDev(path.join(repoRoot, ".env.dev"));
	}
	const env = process.env;
	const rules = defaultRules(opts.rules);
	const token = platformToken(env);
	const org = organization(env);
	if (!token) throw new Error("No Turso Platform API token (TURSO_PLATFORM_API_TOKEN / TURSO_API_TOKEN / TF_VAR_turso_api_token).");
	if (!org) throw new Error("No Turso organisation (TURSO_ORGANIZATION / TF_VAR_TURSO_ORGANIZATION).");

	const databases = await listDatabases(org, token);
	const protect = new Map();

	for (const name of opts.protect) addProtect(protect, name, "--protect");

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

	const plan = planRetention({ databases, rules, now: new Date(), protect });
	const summary = summarisePlan(plan, rules);
	const liveProduction = { identified: prodMatches.length > 0, note: prodLive.note };
	const liveStaging = { identified: stagingMatches.length > 0, note: stagingLive.note };
	const otherCount = databases.length - plan.length;

	if (opts.json) {
		console.log(JSON.stringify({
			mode: opts.delete ? "delete" : "dry-run",
			databasesInOrganisation: databases.length,
			notInScope: otherCount,
			liveProduction,
			liveStaging,
			localBackupRecords: records.length,
			summary,
			plan,
		}, null, 2));
	} else {
		console.log(`Turso backup retention (${opts.delete ? "DELETE" : "dry-run"})`);
		console.log(`Databases in organisation: ${databases.length} (${otherCount} not CI backup branches; never touched)`);
		console.log(`Live production Worker DB identified: ${liveProduction.identified ? "yes" : "no"} (${liveProduction.note})`);
		console.log(`Live staging Worker DB identified: ${liveStaging.identified ? "yes" : "no"} (${liveStaging.note})`);
		console.log(`Local backup records read: ${records.length}`);
		for (const s of summary) {
			console.log(`\n${s.prefix}* [${s.environment}] ${s.policy}`);
			console.log(`  total ${s.total}, keep ${s.keep}, would delete ${s.wouldDelete}; ages ${fmtAge(s.newestAgeDays)} .. ${fmtAge(s.oldestAgeDays)}`);
			for (const e of plan.filter((p) => p.prefix === s.prefix)) {
				console.log(`  ${e.action === "delete" ? "DELETE" : "keep  "}  ${e.name}  ${fmtAge(e.ageDays)}  ${e.reasons.join("; ")}`);
			}
		}
	}

	const toDelete = plan.filter((e) => e.action === "delete");
	if (!opts.delete) {
		console.error(`\nDry-run: ${toDelete.length} branch(es) would be deleted. Nothing was deleted.`);
		return 0;
	}
	const refusals = deleteRefusals({ plan, expectCount: opts.expectCount, env, liveProduction, liveStaging });
	if (refusals.length) {
		for (const r of refusals) console.error(`Refusing to delete: ${r}`);
		return 2;
	}
	for (const e of toDelete) {
		await deleteDatabase(org, token, e.name);
		console.error(`Deleted ${e.name} (${fmtAge(e.ageDays)})`);
	}
	console.error(`Deleted ${toDelete.length} branch(es).`);
	return 0;
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
