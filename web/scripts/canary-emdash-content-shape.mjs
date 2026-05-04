/**
 * Classify `data.content` for an EmDash entry without PowerShell UTF-8 mangling
 * (avoid piping `npx emdash ... --json` to `Out-File` on Windows).
 *
 * Usage:
 *   node web/scripts/canary-emdash-content-shape.mjs <baseUrl> <collection> <slug> [--published]
 *
 * Example:
 *   node web/scripts/canary-emdash-content-shape.mjs https://staging.freedomtimes.news posts my-slug --published
 *
 * Requires `npx emdash` auth the same way as other CLI commands (e.g. ~/.config/emdash/auth.json).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function runEmdashGet(webDir, args) {
	const res = spawnSync("npx", ["emdash", "content", "get", ...args], {
		cwd: webDir,
		encoding: "utf8",
		shell: true,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (res.status !== 0) {
		process.stderr.write(res.stderr || res.stdout || "");
		process.exit(res.status ?? 1);
	}
	return (res.stdout ?? "").trim();
}

const [, , baseUrl, collection, slug, ...rest] = process.argv;
if (!baseUrl || !collection || !slug) {
	console.error(
		"Usage: node web/scripts/canary-emdash-content-shape.mjs <baseUrl> <collection> <slug> [--published]",
	);
	process.exit(1);
}

const webDir = join(__dirname, "..");
const args = [collection, slug, "-u", baseUrl, "--json", ...rest];
const raw = runEmdashGet(webDir, args);
const doc = JSON.parse(raw);
const c = doc.data?.content;
const label = Array.isArray(c) ? `PT blocks ${c.length}` : `STR chars ${String(c ?? "").length}`;
console.log(`${baseUrl} ${collection}/${slug} ${label}`);
