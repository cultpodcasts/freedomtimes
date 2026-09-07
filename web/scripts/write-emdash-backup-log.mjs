#!/usr/bin/env node
/**
 * Write the operator-visible production/staging EmDash backup log into
 * freedomtimes-agents/data/backups/ (committed artifact — never secrets).
 *
 * Canonical path:
 *   ../freedomtimes-agents/data/backups/{prod|staging}-emdash-YYYYMMDD-HHMMSS.json
 *
 * Usage:
 *   node web/scripts/write-emdash-backup-log.mjs --from-json path/to/payload.json
 *   node web/scripts/write-emdash-backup-log.mjs --stdin
 *
 * Payload keys (no tokens): sourceDatabase, destination.tursoBranch, destination.localFile,
 * posts.{raw,active,published,draft,deleted}, workerTursoHost, verificationPass, notes.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

function agentsRepoRoot() {
	const fromEnv = process.env.FREEDOMTIMES_AGENTS_DIR?.trim();
	if (fromEnv) return path.resolve(fromEnv);
	return path.resolve(repoRoot, "..", "freedomtimes-agents");
}

function stampFromIsoOrNow(iso) {
	const d = iso ? new Date(iso) : new Date();
	if (Number.isNaN(d.getTime())) {
		throw new Error(`Invalid createdAtUtc: ${iso}`);
	}
	const y = d.getUTCFullYear();
	const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
	const da = String(d.getUTCDate()).padStart(2, "0");
	const h = String(d.getUTCHours()).padStart(2, "0");
	const mi = String(d.getUTCMinutes()).padStart(2, "0");
	const s = String(d.getUTCSeconds()).padStart(2, "0");
	return `${y}${mo}${da}-${h}${mi}${s}`;
}

function stripSecrets(obj) {
	if (!obj || typeof obj !== "object") return obj;
	const banned = /token|password|secret|authorization|jwt/i;
	if (Array.isArray(obj)) return obj.map(stripSecrets);
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [k, v] of Object.entries(obj)) {
		if (banned.test(k)) continue;
		out[k] = typeof v === "object" && v !== null ? stripSecrets(v) : v;
	}
	return out;
}

function parseArgs(argv) {
	const out = { fromJson: "", stdin: false, environment: "", stamp: "", agentsDir: "" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--from-json") out.fromJson = argv[++i];
		else if (a === "--stdin") out.stdin = true;
		else if (a === "--environment") out.environment = argv[++i];
		else if (a === "--stamp") out.stamp = argv[++i];
		else if (a === "--agents-dir") out.agentsDir = argv[++i];
	}
	return out;
}

function readPayload(args) {
	if (args.fromJson) {
		return JSON.parse(readFileSync(path.resolve(args.fromJson), "utf8"));
	}
	if (args.stdin) {
		return JSON.parse(readFileSync(0, "utf8"));
	}
	throw new Error("Pass --from-json <file> or --stdin");
}

export function backupLogFileName(environment, stamp) {
	const env = environment === "staging" ? "staging" : "prod";
	return `${env}-emdash-${stamp}.json`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const raw = readPayload(args);
	const environment = (args.environment || raw.environment || "production").toLowerCase();
	const createdAtUtc = raw.createdAtUtc || new Date().toISOString();
	const stamp = args.stamp || stampFromIsoOrNow(createdAtUtc);
	const agentsRoot = args.agentsDir || agentsRepoRoot();
	if (!existsSync(agentsRoot)) {
		throw new Error(
			`freedomtimes-agents repo not found at ${agentsRoot}. Set FREEDOMTIMES_AGENTS_DIR or clone it as a sibling.`,
		);
	}

	const destDir = path.join(agentsRoot, "data", "backups");
	mkdirSync(destDir, { recursive: true });
	const fileName = backupLogFileName(environment, stamp);
	const outPath = path.join(destDir, fileName);

	const log = stripSecrets({
		kind: "emdash-backup-log",
		schemaVersion: 1,
		createdAtUtc,
		environment: environment === "staging" ? "staging" : "production",
		sourceDatabase: raw.sourceDatabase,
		workerTursoHost: raw.workerTursoHost ?? null,
		destination: {
			tursoBranch:
				raw.destination?.tursoBranch ??
				raw.backupDatabase ??
				raw.rollbackDatabase ??
				raw.tursoBranch ??
				null,
			localFile: raw.destination?.localFile ?? raw.backupFile ?? raw.localFile ?? null,
		},
		backupNaming:
			raw.backupNaming ??
			"Turso branch is always prod-backup-YYYYMMDD-HHMMSS (never the Worker source name).",
		posts: {
			ecPostsRaw: raw.posts?.raw ?? raw.posts?.ecPostsRaw ?? null,
			active: raw.posts?.active ?? null,
			published: raw.posts?.published ?? raw.postCount ?? null,
			draft: raw.posts?.draft ?? null,
			deleted: raw.posts?.deleted ?? null,
			byStatus: raw.posts?.byStatus ?? null,
		},
		weeklySlugsSample: raw.weeklySlugsSample ?? [],
		verificationPass: raw.verificationPass ?? raw.verification?.pass ?? null,
		freedomtimesMetadata: raw.freedomtimesMetadata ?? raw.metadataFile ?? null,
		agentsLogPath: `data/backups/${fileName}`,
		notes: raw.notes ?? null,
	});

	if (!log.sourceDatabase) {
		throw new Error("Backup log requires sourceDatabase (Worker-resolved Turso name).");
	}
	if (!log.destination.tursoBranch && !log.destination.localFile) {
		throw new Error("Backup log requires destination.tursoBranch and/or destination.localFile.");
	}

	writeFileSync(outPath, `${JSON.stringify(log, null, 2)}\n`, "utf8");
	console.log(outPath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (e) {
		console.error(e?.message ?? e);
		process.exit(1);
	}
}
