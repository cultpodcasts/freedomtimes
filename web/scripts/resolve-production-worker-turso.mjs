#!/usr/bin/env node
/**
 * Resolve the Turso database the **production Worker actually uses**.
 *
 * Preferred: wrangler getPlatformProxy (remote bindings) → TURSO_DATABASE_URL hostname → db name.
 * Fallback: TURSO_PRODUCTION_EMDASH_DB_URL + TURSO_PRODUCTION_EMDASH_DB_TOKEN (or TURSO_DATABASE_URL
 * when that URL is production EmDash), with an explicit warning that Worker resolve failed.
 *
 * NEVER silently assume freedomtimes-emdash-production — that named DB can be a stale thin corpus
 * while the Worker points at a working branch (incident 2026-09-07).
 *
 * Usage (from repo root or web/):
 *   node web/scripts/resolve-production-worker-turso.mjs
 *   node web/scripts/resolve-production-worker-turso.mjs --json
 *   node web/scripts/resolve-production-worker-turso.mjs --inventory
 *
 * Prints JSON to stdout. Does not print token values.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import {
	NAMED_PRODUCTION_DB_DEFAULT,
	databaseNameFromUrl,
	libsqlHostname,
	countPostInventory,
	listProtectedPosts,
	openLibsql,
	weeklySlugsSample,
	inventoryHash,
} from "./lib/production-emdash-inventory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..");

function parseArgs(argv) {
	const out = {
		json: true,
		inventory: false,
		outPath: "",
		databaseName: "",
		organization: process.env.TURSO_ORGANIZATION || process.env.TURSO_ORG || "cultpodcasts",
		allowEnvFallback: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") out.json = true;
		else if (a === "--inventory") out.inventory = true;
		else if (a === "--no-env-fallback") out.allowEnvFallback = false;
		else if (a === "--out" && argv[i + 1]) out.outPath = argv[++i];
		else if (a === "--database-name" && argv[i + 1]) out.databaseName = argv[++i];
		else if (a === "--organization" && argv[i + 1]) out.organization = argv[++i];
		else if (a === "--help" || a === "-h") {
			console.log(`Usage: node resolve-production-worker-turso.mjs [--inventory] [--out path] [--database-name name]
  --no-env-fallback   Fail if Worker proxy resolve fails (do not use .env / process TURSO_*)`);
			process.exit(0);
		}
	}
	return out;
}

function looksProductionEmdashUrl(url) {
	const h = libsqlHostname(url);
	return Boolean(h) && (
		h.includes("-emdash-production") ||
		h.includes("prod-work-") ||
		h.includes("prod-backup-") ||
		h.includes("prod-rollback-")
	);
}

async function resolveFromWorkerProxy() {
	const configPath = path.join(webDir, "wrangler.jsonc");
	const { env, dispose } = await getPlatformProxy({
		configPath,
		environment: "production",
		remoteBindings: true,
	});
	try {
		const url = String(env.TURSO_DATABASE_URL || "").trim();
		const token = String(env.TURSO_AUTH_TOKEN || "").trim();
		if (!url || !token) {
			throw new Error("Worker remote bindings missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
		}
		return { url, token, source: "wrangler-getPlatformProxy-production" };
	} finally {
		await dispose();
	}
}

function resolveFromEnv() {
	const candidates = [
		{
			url: process.env.TURSO_PRODUCTION_EMDASH_DB_URL?.trim(),
			token: process.env.TURSO_PRODUCTION_EMDASH_DB_TOKEN?.trim(),
			source: "TURSO_PRODUCTION_EMDASH_DB_URL",
		},
		{
			url: process.env.TURSO_DATABASE_URL?.trim(),
			token: process.env.TURSO_AUTH_TOKEN?.trim(),
			source: "TURSO_DATABASE_URL",
		},
	];
	for (const c of candidates) {
		if (c.url && c.token && looksProductionEmdashUrl(c.url)) {
			return c;
		}
	}
	return null;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	let resolved;
	let warnings = [];

	try {
		resolved = await resolveFromWorkerProxy();
	} catch (e) {
		const msg = String(e?.message ?? e);
		warnings.push(`Worker proxy resolve failed: ${msg}`);
		if (!args.allowEnvFallback) {
			console.error(
				JSON.stringify({
					ok: false,
					error: "worker_resolve_failed",
					message: msg,
					hint: "Ensure Cloudflare auth for wrangler, or pass env TURSO_PRODUCTION_EMDASH_DB_URL + TOKEN matching the live Worker (not a stale named DB).",
				}),
			);
			process.exit(2);
		}
		resolved = resolveFromEnv();
		if (!resolved) {
			console.error(
				JSON.stringify({
					ok: false,
					error: "resolve_failed",
					message: msg,
					hint: "Set TURSO_PRODUCTION_EMDASH_DB_URL + TURSO_PRODUCTION_EMDASH_DB_TOKEN to the Worker-resolved DB, or fix wrangler auth.",
				}),
			);
			process.exit(2);
		}
		warnings.push(
			`Using env fallback ${resolved.source}. Confirm hostname matches the live Worker before backup/promote.`,
		);
	}

	const host = libsqlHostname(resolved.url);
	const databaseName =
		args.databaseName.trim() || databaseNameFromUrl(resolved.url, args.organization);

	if (databaseName === NAMED_PRODUCTION_DB_DEFAULT) {
		warnings.push(
			`Resolved database name is '${NAMED_PRODUCTION_DB_DEFAULT}'. That named DB has been stale/thin while the Worker used a different branch — double-check Worker host before trusting this backup source.`,
		);
	}

	/** @type {Record<string, unknown>} */
	const result = {
		ok: true,
		source: resolved.source,
		workerTursoHost: host,
		databaseName,
		organization: args.organization,
		namedProductionDefault: NAMED_PRODUCTION_DB_DEFAULT,
		tokenPresent: Boolean(resolved.token),
		urlPresent: Boolean(resolved.url),
		warnings,
		// Never echo secrets
		hasCredentials: Boolean(resolved.url && resolved.token),
	};

	if (args.inventory) {
		const client = openLibsql(resolved.url, resolved.token);
		try {
			const posts = await listProtectedPosts(client);
			const inventory = await countPostInventory(client);
			result.postCount = posts.length;
			result.posts = inventory;
			result.publishedSlugs = posts.map((p) => p.slug);
			result.weeklySlugsSample = weeklySlugsSample(posts);
			result.inventoryHash = inventoryHash(posts);
		} finally {
			client.close?.();
		}
	}

	// Expose credentials only via env file side-channel for sibling scripts (not in JSON stdout by default).
	// Sibling PowerShell sets process env from a private sidecar when --emit-env-file is used.
	const emitEnv = process.argv.includes("--emit-env-file");
	if (emitEnv) {
		const envPath = path.join(repoRoot, ".release", "backups", "_tmp-worker-turso.env");
		writeFileSync(
			envPath,
			[
				`TURSO_DATABASE_URL=${resolved.url}`,
				`TURSO_AUTH_TOKEN=${resolved.token}`,
				`TURSO_PRODUCTION_EMDASH_DB_URL=${resolved.url}`,
				`TURSO_PRODUCTION_EMDASH_DB_TOKEN=${resolved.token}`,
				`FT_WORKER_TURSO_HOST=${host}`,
				`FT_WORKER_TURSO_DB_NAME=${databaseName}`,
				"",
			].join("\n"),
			{ encoding: "utf8", mode: 0o600 },
		);
		result.emitEnvFile = envPath;
	}

	const text = JSON.stringify(result, null, 2);
	if (args.outPath) {
		writeFileSync(args.outPath, `${text}\n`, "utf8");
	}
	console.log(text);

	// Soft-signal: still exit 0 when ok; callers read warnings.
	if (!result.ok) process.exit(1);
}

main().catch((e) => {
	console.error(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
	process.exit(1);
});
