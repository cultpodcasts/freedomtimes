/**
 * Apply, check, or status EmDash *core* schema migrations (not pt:migrate,
 * not tips/subscriptions SQL).
 *
 * Uses the project CLI (`npx --no-fund emdash migrate`) against
 * `.emdash/migrations.json` from `npm run build`. Apply uses a pre-reviewed
 * `EMDASH_TARGET_FINGERPRINT` in CI/production; local deploy may pin from
 * `--status --json` (`print-fingerprint` / same-run apply for non-prod).
 *
 * Requires TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. Refuses the Astro build
 * placeholder URL so Worker-only deploys cannot migrate the wrong target.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_HOST = "unused-at-build.invalid";
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(webRoot, ".emdash/migrations.json");

const mode = (process.argv[2] || "").trim();
if (!["apply", "check", "status", "print-fingerprint"].includes(mode)) {
	console.error("Usage: node scripts/emdash-core-migrate.mjs <apply|check|status|print-fingerprint>");
	process.exit(1);
}

const tursoUrl = (process.env.TURSO_DATABASE_URL || "").trim();
const tursoToken = (process.env.TURSO_AUTH_TOKEN || "").trim();
if (!tursoUrl || !tursoToken) {
	console.error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN for EmDash core migrate.");
	process.exit(1);
}
if (tursoUrl.includes(PLACEHOLDER_HOST)) {
	console.error(
		`Refusing EmDash core migrate: TURSO_DATABASE_URL is the build placeholder (${PLACEHOLDER_HOST}).`,
	);
	process.exit(1);
}

if (!existsSync(manifestPath)) {
	console.error(
		`No migration manifest at ${manifestPath}. Run npm run build in web/ first.`,
	);
	process.exit(1);
}

function redactedTursoHost(url) {
	try {
		return new URL(url.replace(/^libsql:/i, "https:")).host;
	} catch {
		return "(unparseable-host)";
	}
}

function looksLikeProductionEmdashUrl(url) {
	return /emdash-production/i.test(url);
}

function snippet(text, max = 240) {
	return String(text || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function extractFirstJsonObject(text) {
	const start = text.indexOf("{");
	if (start < 0) {
		throw new Error("no JSON object in CLI stdout");
	}
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escape) {
				escape = false;
				continue;
			}
			if (ch === "\\") {
				escape = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}
	throw new Error("unbalanced JSON object in CLI stdout");
}

function runEmdashMigrate(args, { capture = false } = {}) {
	const npx = process.platform === "win32" ? "npx.cmd" : "npx";
	const result = spawnSync(npx, ["--no-fund", "emdash", "migrate", ...args], {
		cwd: webRoot,
		env: process.env,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

function parseStatusReport(status) {
	if ((status.status ?? 1) !== 0) {
		console.error(
			status.stderr?.trim() ||
				`emdash migrate --status --json failed (exit ${status.status ?? 1}). ${snippet(status.stdout)}`,
		);
		process.exit(status.status ?? 1);
	}
	try {
		return JSON.parse(extractFirstJsonObject(status.stdout || ""));
	} catch (error) {
		console.error(
			`emdash migrate --status --json did not return JSON (${error.message}). ${snippet(status.stdout)}`,
		);
		process.exit(1);
	}
}

function readStatusFingerprint(report) {
	const fingerprint = report?.target?.fingerprint;
	if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
		console.error("emdash migrate --status --json did not include a SHA-256 target fingerprint.");
		process.exit(1);
	}
	return fingerprint;
}

console.error(`EmDash migrate target host: ${redactedTursoHost(tursoUrl)} (mode=${mode})`);

if (mode === "status") {
	const result = runEmdashMigrate(["--status"]);
	process.exit(result.status ?? 1);
}

if (mode === "print-fingerprint") {
	const status = runEmdashMigrate(["--status", "--json"], { capture: true });
	const report = parseStatusReport(status);
	process.stdout.write(`${readStatusFingerprint(report)}\n`);
	process.exit(0);
}

if (mode === "check") {
	const result = runEmdashMigrate(["--check"]);
	process.exit(result.status ?? 1);
}

const pinned = (process.env.EMDASH_TARGET_FINGERPRINT || "").trim();
const requirePinned = Boolean(process.env.GITHUB_ACTIONS) || looksLikeProductionEmdashUrl(tursoUrl);
if (pinned && !FINGERPRINT_RE.test(pinned)) {
	console.error("EMDASH_TARGET_FINGERPRINT must be a 64-character SHA-256 hex digest.");
	process.exit(1);
}
if (requirePinned && !pinned) {
	console.error(
		"Refusing EmDash apply without EMDASH_TARGET_FINGERPRINT (required in CI and for production-looking Turso hosts).",
	);
	process.exit(1);
}

const status = runEmdashMigrate(["--status", "--json"], { capture: true });
const report = parseStatusReport(status);
const statusFingerprint = readStatusFingerprint(report);
const fingerprint = pinned || statusFingerprint;
if (pinned && pinned !== statusFingerprint) {
	console.error(
		"EMDASH_TARGET_FINGERPRINT does not match emdash migrate --status for this TURSO_DATABASE_URL / build. Wrong host or stale pin.",
	);
	process.exit(1);
}
if (!pinned) {
	console.error(
		"EMDASH_TARGET_FINGERPRINT unset; using same-run --status fingerprint (local non-prod only).",
	);
}

console.error(`Applying EmDash core migrations with target fingerprint ${fingerprint}`);
const apply = runEmdashMigrate(["--expected-target-fingerprint", fingerprint]);
process.exit(apply.status ?? 1);
