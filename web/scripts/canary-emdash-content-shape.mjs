/**
 * Classify `data.content` for an EmDash entry without PowerShell UTF-8 mangling
 * (avoid piping `npx emdash ... --json` to `Out-File` on Windows).
 *
 * Usage:
 *   node web/scripts/canary-emdash-content-shape.mjs <baseUrl> <collection> <slug> [--published] [--mcp]
 *
 * Examples:
 *   node web/scripts/canary-emdash-content-shape.mjs https://staging.freedomtimes.news posts my-slug --published
 *   node web/scripts/canary-emdash-content-shape.mjs https://staging.freedomtimes.news posts my-slug --mcp
 *
 * **--mcp** uses HTTP `content_get` (Portable Text truth); ignores `--published` (MCP returns current item).
 *
 * CLI mode requires `npx emdash` auth (e.g. ~/.config/emdash/auth.json).
 * MCP mode requires an accessToken in auth.json for the same **baseUrl** host.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { emdashMcpContentGet } from "./emdash-mcp-client.mjs";

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

function loadAuth() {
	const p = join(homedir(), ".config", "emdash", "auth.json");
	return JSON.parse(readFileSync(p, "utf8"));
}

function tokenFor(auth, baseUrl) {
	const t = auth[baseUrl]?.accessToken;
	if (!t) throw new Error(`No accessToken in auth.json for ${baseUrl}`);
	return t;
}

function classifyContent(c) {
	return Array.isArray(c) ? `PT blocks ${c.length}` : `STR chars ${String(c ?? "").length}`;
}

const [, , baseUrl, collection, slug, ...rest] = process.argv;
if (!baseUrl || !collection || !slug) {
	console.error(
		"Usage: node web/scripts/canary-emdash-content-shape.mjs <baseUrl> <collection> <slug> [--published] [--mcp]",
	);
	process.exit(1);
}

const useMcp = rest.includes("--mcp");
const cliFlags = rest.filter((f) => f !== "--mcp");

if (useMcp && cliFlags.includes("--published")) {
	console.error("[canary] --mcp mode ignores --published (MCP content_get has no published-only flag here).");
}

const webDir = join(__dirname, "..");

if (useMcp) {
	try {
		const auth = loadAuth();
		const token = tokenFor(auth, baseUrl);
		const { item } = await emdashMcpContentGet(baseUrl, token, { collection, id: slug });
		const c = item.data?.content;
		const label = classifyContent(c);
		console.log(`${baseUrl} ${collection}/${slug} ${label} (MCP)`);
	} catch (e) {
		console.error(e?.message ?? e);
		process.exit(1);
	}
} else {
	const args = [collection, slug, "-u", baseUrl, "--json", ...cliFlags];
	const raw = runEmdashGet(webDir, args);
	const doc = JSON.parse(raw);
	const c = doc.data?.content;
	const label = classifyContent(c);
	console.log(`${baseUrl} ${collection}/${slug} ${label} (CLI)`);
}
