#!/usr/bin/env node
/**
 * Verify a production EmDash backup (local .db and/or Turso branch) against the live
 * Worker-resolved inventory (and optionally staging published set).
 *
 * PASS requires:
 * - Every live published post slug appears in the backup (ec_posts, deleted_at IS NULL)
 * - Backup post count is not thinner than live
 * - Live weeklies that exist on staging are not missing from the backup (when --compare-staging)
 *
 * Usage (from repo root):
 *   node web/scripts/verify-production-emdash-backup.mjs --backup-db .release/backups/emdash-production-YYYYMMDD-HHMMSS.db --from-worker
 *   node web/scripts/verify-production-emdash-backup.mjs --backup-branch prod-rollback-YYYYMMDD-HHMMSS --live-url ... --live-token ...
 *   node web/scripts/verify-production-emdash-backup.mjs --check-metadata .release/rollback-branches/<stamp>-<branch>.json --max-age-hours 24
 *   node web/scripts/verify-production-emdash-backup.mjs --check-staging-auth   (#161: staging token preflight only)
 *
 * Staging token (--compare-staging / --check-staging-auth): EMDASH_STAGING_PAT, then
 * EMDASH_STAGING_TOKEN, then ~/.config/emdash/auth.json (web/scripts/lib/staging-emdash-auth.mjs).
 * A missing or rejected token fails with error staging_token_missing / staging_token_rejected,
 * naming the variable (never its value). With --metadata-out, every failure (including those)
 * still writes a report { pass: false, error, message } so the backup metadata says why.
 *
 * Exit 0 = PASS, 1 = FAIL, 2 = usage/config error.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	compareInventories,
	databaseNameFromUrl,
	resolveTursoOrganization,
	libsqlHostname,
	listProtectedPosts,
	listPublishedPostSlugsViaApi,
	openLibsql,
	openSqliteReadonly,
	weeklySlugsSample,
} from "./lib/production-emdash-inventory.mjs";
import {
	STAGING_DEFAULT_URL,
	StagingAuthError,
	checkStagingAuth,
	isAuthRejectionStatus,
	resolveStagingToken,
	stagingTokenMissingError,
	stagingTokenRejectedError,
} from "./lib/staging-emdash-auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..");

function parseArgs(argv) {
	const out = {
		backupDb: "",
		backupBranch: "",
		backupUrl: "",
		backupToken: "",
		liveUrl: "",
		liveToken: "",
		fromWorker: false,
		compareStaging: false,
		checkStagingAuth: false,
		stagingUrl: process.env.EMDASH_STAGING_URL || STAGING_DEFAULT_URL,
		metadataOut: "",
		checkMetadata: "",
		maxAgeHours: 24,
		organization: resolveTursoOrganization(),
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--backup-db") out.backupDb = next();
		else if (a === "--backup-branch") out.backupBranch = next();
		else if (a === "--backup-url") out.backupUrl = next();
		else if (a === "--backup-token") out.backupToken = next();
		else if (a === "--live-url") out.liveUrl = next();
		else if (a === "--live-token") out.liveToken = next();
		else if (a === "--from-worker") out.fromWorker = true;
		else if (a === "--compare-staging") out.compareStaging = true;
		else if (a === "--check-staging-auth") out.checkStagingAuth = true;
		else if (a === "--staging-url") out.stagingUrl = next();
		else if (a === "--metadata-out") out.metadataOut = next();
		else if (a === "--check-metadata") out.checkMetadata = next();
		else if (a === "--max-age-hours") out.maxAgeHours = Number(next());
		else if (a === "--organization") out.organization = next();
		else if (a === "--help" || a === "-h") {
			console.log(`verify-production-emdash-backup.mjs
  --backup-db <path.db>
  --backup-branch <turso-name>   (requires --backup-url/--backup-token or env for that branch)
  --from-worker                 resolve live inventory via wrangler production bindings
  --live-url / --live-token     live compare target
  --compare-staging             also require live weeklies present on staging to be in backup
                                (token: EMDASH_STAGING_PAT, EMDASH_STAGING_TOKEN or auth.json)
  --check-staging-auth          only check the staging token works (read-only GET); exit 0 / 2
  --staging-url <origin>        staging EmDash (default EMDASH_STAGING_URL or ${STAGING_DEFAULT_URL})
  --check-metadata <json>       gate: require verification.pass and freshness
  --max-age-hours <n>           with --check-metadata (default 24)
  --metadata-out <json>         write verification report`);
			process.exit(0);
		}
	}
	return out;
}

async function resolveWorkerLive() {
	const { spawnSync } = await import("node:child_process");
	const script = path.join(__dirname, "resolve-production-worker-turso.mjs");
	const r = spawnSync(
		process.execPath,
		[script, "--inventory", "--emit-env-file"],
		{
			cwd: repoRoot,
			encoding: "utf8",
			env: process.env,
		},
	);
	if (r.status !== 0) {
		throw new Error(`resolve-production-worker-turso failed: ${r.stderr || r.stdout}`);
	}
	const resolved = JSON.parse(r.stdout);
	const envFile = resolved.emitEnvFile;
	if (!envFile || !existsSync(envFile)) {
		throw new Error("resolve did not emit env file with Worker credentials");
	}
	const envText = readFileSync(envFile, "utf8");
	const map = Object.fromEntries(
		envText
			.split(/\r?\n/)
			.filter((l) => l.includes("="))
			.map((l) => {
				const i = l.indexOf("=");
				return [l.slice(0, i), l.slice(i + 1)];
			}),
	);
	return {
		resolved,
		url: map.TURSO_DATABASE_URL,
		token: map.TURSO_AUTH_TOKEN,
		posts: (resolved.publishedSlugs || []).map((slug) => ({ slug, status: "published" })),
	};
}

function findNewestVerifiedMetadata(metaDir, maxAgeHours) {
	if (!existsSync(metaDir)) return null;
	const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
	const files = readdirSync(metaDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.join(metaDir, f))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	for (const file of files) {
		try {
			const meta = JSON.parse(readFileSync(file, "utf8"));
			const created = Date.parse(meta.createdAtUtc || meta.verification?.verifiedAtUtc || "");
			if (!Number.isFinite(created) || created < cutoff) continue;
			if (meta.verification?.pass === true) {
				return { file, meta };
			}
		} catch {
			/* skip */
		}
	}
	return null;
}

async function loadBackupPosts(args) {
	if (args.backupDb) {
		const db = openSqliteReadonly(path.resolve(repoRoot, args.backupDb));
		try {
			return {
				posts: await listProtectedPosts(db),
				source: { type: "file", path: args.backupDb },
			};
		} finally {
			db.close();
		}
	}
	const url = args.backupUrl || process.env.TURSO_BACKUP_DATABASE_URL || "";
	const token = args.backupToken || process.env.TURSO_BACKUP_AUTH_TOKEN || "";
	if (!url || !token) {
		throw new Error(
			"Backup libsql requires --backup-url/--backup-token (or TURSO_BACKUP_*), or use --backup-db",
		);
	}
	const client = openLibsql(url, token);
	try {
		const posts = await listProtectedPosts(client);
		return {
			posts,
			source: {
				type: "libsql",
				host: libsqlHostname(url),
				databaseName: args.backupBranch || databaseNameFromUrl(url, args.organization),
			},
		};
	} finally {
		client.close?.();
	}
}

/** Set by main() so the top-level catch can still write --metadata-out on failure (#161). */
let parsedArgs = null;

function writeReport(metadataOut, report) {
	const out = path.resolve(repoRoot, metadataOut);
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	console.error(`Wrote verification report: ${out}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	parsedArgs = args;

	if (args.checkStagingAuth) {
		const r = await checkStagingAuth(args.stagingUrl);
		console.log(
			JSON.stringify({
				pass: true,
				mode: "check-staging-auth",
				stagingUrl: args.stagingUrl,
				stagingTokenSource: r.tokenSource,
				stagingStatus: r.status,
			}),
		);
		process.exit(0);
	}

	if (args.checkMetadata) {
		const metaPath = path.resolve(repoRoot, args.checkMetadata);
		if (args.checkMetadata === "newest" || args.checkMetadata === "auto") {
			const found = findNewestVerifiedMetadata(
				path.join(repoRoot, ".release", "rollback-branches"),
				args.maxAgeHours,
			);
			if (!found) {
				console.error(
					JSON.stringify(
						{
							pass: false,
							error: "no_fresh_verified_backup",
							message: `No .release/rollback-branches/*.json with verification.pass=true newer than ${args.maxAgeHours}h. Run: pwsh ./scripts/backup-production-emdash.ps1 -AllowProduction`,
						},
						null,
						2,
					),
				);
				process.exit(1);
			}
			const report = {
				pass: true,
				mode: "check-metadata",
				metadataFile: found.file,
				createdAtUtc: found.meta.createdAtUtc,
				sourceDatabase: found.meta.sourceDatabase,
				backupDatabase: found.meta.backupDatabase ?? found.meta.rollbackDatabase,
				rollbackDatabase: found.meta.rollbackDatabase ?? found.meta.backupDatabase,
				workerTursoHost: found.meta.workerTursoHost,
				postCount: found.meta.postCount ?? found.meta.verification?.backupCount,
				verification: found.meta.verification,
			};
			console.log(JSON.stringify(report, null, 2));
			console.log("PASS: fresh verified production backup metadata found");
			process.exit(0);
		}
		if (!existsSync(metaPath)) {
			console.error(JSON.stringify({ pass: false, error: "metadata_missing", path: metaPath }));
			process.exit(1);
		}
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		const created = Date.parse(meta.createdAtUtc || "");
		const ageOk =
			Number.isFinite(created) && Date.now() - created <= args.maxAgeHours * 3600 * 1000;
		const pass = meta.verification?.pass === true && ageOk;
		const report = {
			pass,
			mode: "check-metadata",
			metadataFile: metaPath,
			ageOk,
			maxAgeHours: args.maxAgeHours,
			verificationPass: meta.verification?.pass === true,
			createdAtUtc: meta.createdAtUtc,
			failures: pass
				? []
				: [
						!meta.verification?.pass ? "verification.pass is not true" : null,
						!ageOk ? `metadata older than ${args.maxAgeHours}h` : null,
					].filter(Boolean),
			meta: {
				sourceDatabase: meta.sourceDatabase,
				backupDatabase: meta.backupDatabase ?? meta.rollbackDatabase,
				rollbackDatabase: meta.rollbackDatabase ?? meta.backupDatabase,
				workerTursoHost: meta.workerTursoHost,
				postCount: meta.postCount,
			},
		};
		console.log(JSON.stringify(report, null, 2));
		console.log(pass ? "PASS" : "FAIL");
		process.exit(pass ? 0 : 1);
	}

	if (!args.backupDb && !args.backupUrl && !args.backupBranch) {
		console.error(
			"Provide --backup-db and/or --backup-url (with --backup-branch optional), or --check-metadata auto",
		);
		process.exit(2);
	}

	let livePosts;
	let liveMeta = {};
	if (args.fromWorker) {
		const w = await resolveWorkerLive();
		livePosts = w.posts.length
			? w.posts
			: await listProtectedPosts(openLibsql(w.url, w.token));
		liveMeta = {
			workerTursoHost: w.resolved.workerTursoHost,
			databaseName: w.resolved.databaseName,
			source: w.resolved.source,
		};
		if (!livePosts.length && w.url) {
			const client = openLibsql(w.url, w.token);
			try {
				livePosts = await listProtectedPosts(client);
			} finally {
				client.close?.();
			}
		}
	} else if (args.liveUrl && args.liveToken) {
		const client = openLibsql(args.liveUrl, args.liveToken);
		try {
			livePosts = await listProtectedPosts(client);
			liveMeta = {
				workerTursoHost: libsqlHostname(args.liveUrl),
				databaseName: databaseNameFromUrl(args.liveUrl, args.organization),
				source: "cli-live-url",
			};
		} finally {
			client.close?.();
		}
	} else {
		console.error("Provide --from-worker or --live-url + --live-token");
		process.exit(2);
	}

	const backup = await loadBackupPosts(args);
	let stagingPublishedSlugs = [];
	let stagingTokenSource = null;
	if (args.compareStaging) {
		const { token: tok, source } = resolveStagingToken(args.stagingUrl);
		if (!tok) throw stagingTokenMissingError(args.stagingUrl);
		stagingTokenSource = source;
		let stagingPosts;
		try {
			stagingPosts = await listPublishedPostSlugsViaApi(args.stagingUrl, tok);
		} catch (e) {
			if (isAuthRejectionStatus(e?.status)) throw stagingTokenRejectedError(args.stagingUrl, e.status, source);
			throw e;
		}
		stagingPublishedSlugs = stagingPosts.map((p) => p.slug);
	}

	const comparison = compareInventories(backup.posts, livePosts, {
		stagingPublishedSlugs,
		label: "backup-vs-worker-live",
	});

	const report = {
		pass: comparison.pass,
		verifiedAtUtc: new Date().toISOString(),
		backupSource: backup.source,
		live: liveMeta,
		backupCount: comparison.backupCount,
		liveCount: comparison.liveCount,
		missingInBackup: comparison.missingInBackup,
		extraInBackup: comparison.extraInBackup,
		statusMismatch: comparison.statusMismatch,
		weeklySlugsSample: comparison.weeklySlugsSample,
		liveWeeklySlugsSample: comparison.liveWeeklySlugsSample,
		inventoryHash: comparison.inventoryHash,
		liveInventoryHash: comparison.liveInventoryHash,
		failures: comparison.failures,
		stagingCompare: args.compareStaging
			? {
					stagingPublishedCount: stagingPublishedSlugs.length,
					stagingTokenSource,
					missingRecentWeekliesVsStaging: comparison.missingRecentWeekliesVsStaging,
				}
			: null,
	};

	const text = JSON.stringify(report, null, 2);
	console.log(text);
	console.log(report.pass ? "PASS" : "FAIL");
	if (!report.pass) {
		for (const f of report.failures) console.error(`  - ${f}`);
	}

	if (args.metadataOut) writeReport(args.metadataOut, report);

	process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
	// error is a short machine-readable kind (the CI summary prints only that); message has detail.
	const report =
		e instanceof StagingAuthError
			? e.toReport()
			: { pass: false, error: "verify_error", message: String(e?.message ?? e) };
	report.verifiedAtUtc = new Date().toISOString();
	console.error(JSON.stringify(report));
	if (parsedArgs?.metadataOut && !parsedArgs.checkMetadata && !parsedArgs.checkStagingAuth) {
		try {
			writeReport(parsedArgs.metadataOut, report);
		} catch (w) {
			console.error(`Could not write the failure report: ${w?.message ?? w}`);
		}
	}
	process.exit(2);
});
