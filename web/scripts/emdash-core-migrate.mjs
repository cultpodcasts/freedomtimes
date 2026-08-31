/**
 * Apply, check, or status EmDash *core* schema migrations (not pt:migrate,
 * not tips/subscriptions SQL).
 *
 * Uses the project CLI (`npx emdash migrate`) against `.emdash/migrations.json`
 * from `npm run build`. Non-interactive apply reads the fingerprint from
 * `--status --json` and passes `--expected-target-fingerprint`.
 *
 * Requires TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. Refuses the Astro build
 * placeholder URL so Worker-only deploys cannot migrate the wrong target.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_HOST = "unused-at-build.invalid";
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(webRoot, ".emdash/migrations.json");

const mode = (process.argv[2] || "").trim();
if (!["apply", "check", "status"].includes(mode)) {
	console.error("Usage: node scripts/emdash-core-migrate.mjs <apply|check|status>");
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

function runEmdashMigrate(args, { captureStdout = false } = {}) {
	const npx = process.platform === "win32" ? "npx.cmd" : "npx";
	const result = spawnSync(npx, ["emdash", "migrate", ...args], {
		cwd: webRoot,
		env: process.env,
		encoding: "utf8",
		stdio: captureStdout ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	if (result.error) {
		throw result.error;
	}
	return result;
}

if (mode === "status") {
	const result = runEmdashMigrate(["--status"]);
	process.exit(result.status ?? 1);
}

if (mode === "check") {
	const result = runEmdashMigrate(["--check"]);
	process.exit(result.status ?? 1);
}

const status = runEmdashMigrate(["--status", "--json"], { captureStdout: true });
if ((status.status ?? 1) !== 0) {
	console.error(status.stderr || "emdash migrate --status --json failed.");
	process.exit(status.status ?? 1);
}

let report;
try {
	report = JSON.parse(status.stdout);
} catch {
	console.error("emdash migrate --status --json did not return JSON.");
	process.exit(1);
}

const fingerprint = report?.target?.fingerprint;
if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) {
	console.error("emdash migrate --status --json did not include a SHA-256 target fingerprint.");
	process.exit(1);
}

console.error(`Applying EmDash core migrations with target fingerprint ${fingerprint}`);
const apply = runEmdashMigrate(["--expected-target-fingerprint", fingerprint]);
process.exit(apply.status ?? 1);
