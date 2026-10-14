/**
 * Shared helpers for production EmDash backup resolve / verify.
 * Inventory is published posts: ec_posts where deleted_at IS NULL (and status = published when column exists).
 */

import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const NAMED_PRODUCTION_DB_DEFAULT = "freedomtimes-emdash-production";
/** New production EmDash backups (Turso branch). Never name backups after the Worker source DB. */
export const BACKUP_BRANCH_PREFIX = "prod-backup-";
/** Legacy backups created before the prod-backup-* rename. Still valid DR restore sources. */
export const ROLLBACK_BRANCH_PREFIX = "prod-rollback-";
export const BACKUP_FILE_PREFIX = "emdash-production-";

/** @param {string} name */
export function isKnownProductionBackupBranch(name) {
	const n = String(name || "").trim();
	return n.startsWith(BACKUP_BRANCH_PREFIX) || n.startsWith(ROLLBACK_BRANCH_PREFIX);
}

/** @param {string} url */
export function libsqlHostname(url) {
	if (!url || typeof url !== "string") return "";
	let host = url.trim().replace(/^libsql:\/\//i, "").replace(/^https:\/\//i, "");
	host = host.split("?")[0];
	const at = host.lastIndexOf("@");
	if (at >= 0) host = host.slice(at + 1);
	return host.replace(/\/+$/, "").toLowerCase();
}

/**
 * Turso organization slug, from (in order): explicit arg, TURSO_ORGANIZATION,
 * TURSO_ORG, TF_VAR_TURSO_ORGANIZATION / TF_VAR_turso_organization (.env.dev).
 * No hard-coded default: the old "cultpodcasts" default never matched the real
 * org, so the `-<org>` suffix was left on the derived DB name.
 * @param {string} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveTursoOrganization(explicit, env = process.env) {
	for (const v of [explicit, env.TURSO_ORGANIZATION, env.TURSO_ORG, env.TF_VAR_TURSO_ORGANIZATION, env.TF_VAR_turso_organization]) {
		if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
	}
	return "";
}

/**
 * Parse a Turso libsql hostname `{dbname}-{org}[.{region}].turso.io`.
 * The org suffix is stripped when the org is known (arg/env), or when the
 * host is `{knownDbName}-{org}` for one of `knownDatabaseNames`.
 * `orgStripped: false` means the name may still carry `-{org}`; callers must
 * not use it for backups without an explicit database name.
 * @param {string} hostname
 * @param {{ organization?: string, env?: NodeJS.ProcessEnv, knownDatabaseNames?: string[] }} [opts]
 * @returns {{ databaseName: string, organization: string, orgStripped: boolean }}
 */
export function parseTursoHostname(hostname, opts = {}) {
	const host = String(hostname || "")
		.trim()
		.toLowerCase()
		.replace(/\.turso\.io$/i, "");
	const nameAndOrg = host.split(".")[0] || "";
	const org = resolveTursoOrganization(opts.organization, opts.env ?? process.env);
	if (org && nameAndOrg.endsWith(`-${org}`) && nameAndOrg.length > org.length + 1) {
		return { databaseName: nameAndOrg.slice(0, -(org.length + 1)), organization: org, orgStripped: true };
	}
	for (const known of opts.knownDatabaseNames ?? [NAMED_PRODUCTION_DB_DEFAULT]) {
		const k = known.trim().toLowerCase();
		if (k && nameAndOrg.startsWith(`${k}-`) && /^[a-z0-9-]+$/.test(nameAndOrg.slice(k.length + 1))) {
			return { databaseName: k, organization: nameAndOrg.slice(k.length + 1), orgStripped: true };
		}
	}
	return { databaseName: nameAndOrg, organization: org, orgStripped: false };
}

/**
 * Derive Turso database name from libsql hostname (see parseTursoHostname).
 * @param {string} hostname
 * @param {string} [organization]
 */
export function databaseNameFromHostname(hostname, organization) {
	return parseTursoHostname(hostname, { organization }).databaseName;
}

/** @param {string} url @param {string} [organization] */
export function databaseNameFromUrl(url, organization) {
	return databaseNameFromHostname(libsqlHostname(url), organization);
}

/** @param {import("@libsql/client").Client} db */
async function tableColumns(db) {
	const res = await db.execute("PRAGMA table_info(ec_posts)");
	return new Set(res.rows.map((r) => String(r.name)));
}

/**
 * @param {import("@libsql/client").Client} db
 * @returns {Promise<{ slug: string, status: string }[]>}
 */
export async function listProtectedPosts(db) {
	const cols = await tableColumns(db);
	if (!cols.has("slug")) {
		throw new Error("ec_posts has no slug column — cannot inventory posts");
	}

	const where = [];
	if (cols.has("deleted_at")) {
		where.push("deleted_at IS NULL");
	}
	if (cols.has("status")) {
		where.push("lower(coalesce(status, '')) = 'published'");
	}
	const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const sql = `SELECT slug, ${cols.has("status") ? "status" : "'unknown' AS status"}
               FROM ec_posts
               ${whereSql}
               ORDER BY slug`;

	const res = await db.execute(sql);
	return res.rows.map((r) => ({
		slug: String(r.slug),
		status: String(r.status ?? "unknown"),
	}));
}

/**
 * Full ec_posts inventory for backup logs (raw / published / draft / deleted).
 * @param {import("@libsql/client").Client} db
 */
export async function countPostInventory(db) {
	const cols = await tableColumns(db);
	if (!cols.has("slug")) {
		throw new Error("ec_posts has no slug column — cannot inventory posts");
	}
	const raw = Number((await db.execute("SELECT count(*) AS n FROM ec_posts")).rows[0].n);
	const deleted = cols.has("deleted_at")
		? Number(
				(await db.execute("SELECT count(*) AS n FROM ec_posts WHERE deleted_at IS NOT NULL")).rows[0]
					.n,
			)
		: 0;
	const active = raw - deleted;
	let published = 0;
	let draft = 0;
	/** @type {{ status: string, n: number }[]} */
	let byStatus = [];
	if (cols.has("status")) {
		const where = cols.has("deleted_at") ? "WHERE deleted_at IS NULL" : "";
		const res = await db.execute(
			`SELECT lower(coalesce(status, 'unknown')) AS status, count(*) AS n FROM ec_posts ${where} GROUP BY 1`,
		);
		byStatus = res.rows.map((r) => ({ status: String(r.status), n: Number(r.n) }));
		published = byStatus.find((s) => s.status === "published")?.n ?? 0;
		draft = byStatus.find((s) => s.status === "draft")?.n ?? 0;
	}
	return { raw, active, deleted, published, draft, byStatus };
}

/** @param {{ slug: string }[]} posts */
export function weeklySlugsSample(posts, limit = 12) {
	return posts
		.map((p) => p.slug)
		.filter((s) => /^weekly-summary-/i.test(s))
		.sort()
		.slice(-limit);
}

/** @param {{ slug: string }[]} posts */
export function inventoryHash(posts) {
	const payload = posts
		.map((p) => p.slug)
		.sort()
		.join("\n");
	return createHash("sha256").update(payload).digest("hex");
}

/**
 * @param {{ slug: string, status?: string }[]} backupPosts
 * @param {{ slug: string, status?: string }[]} livePosts
 * @param {{ stagingPublishedSlugs?: string[], label?: string }} [opts]
 */
export function compareInventories(backupPosts, livePosts, opts = {}) {
	const backupMap = new Map(backupPosts.map((p) => [p.slug, p.status ?? ""]));
	const liveMap = new Map(livePosts.map((p) => [p.slug, p.status ?? ""]));
	const missingInBackup = [];
	const statusMismatch = [];
	for (const [slug, status] of liveMap) {
		if (!backupMap.has(slug)) missingInBackup.push(slug);
		else if (backupMap.get(slug) !== status) {
			statusMismatch.push({ slug, live: status, backup: backupMap.get(slug) });
		}
	}
	const extraInBackup = [];
	for (const slug of backupMap.keys()) {
		if (!liveMap.has(slug)) extraInBackup.push(slug);
	}

	const liveCount = livePosts.length;
	const backupCount = backupPosts.length;
	const thinVsLive = backupCount < liveCount;

	const stagingSlugs = opts.stagingPublishedSlugs ?? [];
	const missingRecentWeekliesVsStaging = stagingSlugs.filter(
		(s) => /^weekly-summary-/i.test(s) && liveMap.has(s) && !backupMap.has(s),
	);
	const thinVsStagingWeeklies =
		stagingSlugs.filter((s) => /^weekly-summary-/i.test(s) && liveMap.has(s)).length >
			weeklySlugsSample(backupPosts).length &&
		missingRecentWeekliesVsStaging.length > 0;

	const failures = [];
	if (missingInBackup.length > 0) {
		failures.push(
			`Backup missing ${missingInBackup.length} live published slug(s): ${missingInBackup.slice(0, 8).join(", ")}${missingInBackup.length > 8 ? "…" : ""}`,
		);
	}
	if (thinVsLive) {
		failures.push(
			`Backup is thin vs live Worker inventory: backup=${backupCount} live=${liveCount}`,
		);
	}
	if (missingRecentWeekliesVsStaging.length > 0) {
		failures.push(
			`Backup missing live weekly slug(s) present on staging/live: ${missingRecentWeekliesVsStaging.slice(0, 8).join(", ")}`,
		);
	}

	const pass = failures.length === 0;
	return {
		pass,
		label: opts.label ?? "backup-vs-live",
		backupCount,
		liveCount,
		missingInBackup,
		extraInBackup,
		statusMismatch,
		thinVsLive,
		thinVsStagingWeeklies,
		missingRecentWeekliesVsStaging,
		failures,
		weeklySlugsSample: weeklySlugsSample(backupPosts),
		liveWeeklySlugsSample: weeklySlugsSample(livePosts),
		inventoryHash: inventoryHash(backupPosts),
		liveInventoryHash: inventoryHash(livePosts),
	};
}

/** @param {string} url @param {string} authToken */
export function openLibsql(url, authToken) {
	if (!url?.trim() || !authToken?.trim()) {
		throw new Error("TURSO url and auth token are required");
	}
	return createClient({ url: url.trim(), authToken: authToken.trim() });
}

/** @param {string} filePath */
export function openSqliteReadonly(filePath) {
	const href = pathToFileURL(filePath).href;
	return createClient({ url: href });
}

/**
 * Load published post slugs from EmDash content list API (staging or production HTTP).
 * @param {string} baseUrl
 * @param {string} token
 */
export async function listPublishedPostSlugsViaApi(baseUrl, token) {
	const url = `${baseUrl.replace(/\/$/, "")}/_emdash/api/content/posts?status=published&limit=500`;
	const r = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	const txt = await r.text();
	let j;
	try {
		j = JSON.parse(txt);
	} catch {
		throw new Error(`Non-JSON ${r.status} ${url}: ${txt.slice(0, 200)}`);
	}
	if (!r.ok) {
		throw new Error(`${r.status} GET ${url}: ${j?.error?.message ?? txt}`);
	}
	const items = j?.data?.items ?? j?.items ?? [];
	return items
		.map((i) => ({ slug: String(i.slug), status: String(i.status ?? "published") }))
		.filter((p) => p.slug)
		.sort((a, b) => a.slug.localeCompare(b.slug));
}
