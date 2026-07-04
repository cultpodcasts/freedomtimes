/**
 * Invoke any EmDash MCP tool via HTTP JSON-RPC `tools/call` (same endpoint as
 * `.cursor/mcp.json`). Use this for **schema** and **content** reads/writes instead of
 * `npx emdash schema` / `npx emdash content` when you need true stored JSON (**AGENTS.md**).
 *
 * **Operators:** run manually from a terminal when you choose.
 * **AI agents:** Cursor MCP only — **Primary guardrails §1** in **AGENTS.md** — do NOT use this script when MCP tools fail in the session.
 *
 * Usage (from repo root):
 *   node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> [argumentsJson]
 *
 * Examples:
 *   node web/scripts/emdash-mcp-tools-call.mjs schema_get_collection '{"slug":"posts"}'
 *   node web/scripts/emdash-mcp-tools-call.mjs --url https://freedomtimes.news schema_get_collection '{"slug":"posts"}'
 *   node web/scripts/emdash-mcp-tools-call.mjs content_get '{"collection":"posts","id":"my-slug"}'
 *
 * Base URL: --url, or EMDASH_MCP_URL, or EMDASH_STAGING_URL, or staging default.
 * Token: EMDASH_MCP_TOKEN, or URL-specific EMDASH_STAGING_TOKEN / EMDASH_PRODUCTION_TOKEN,
 *        or ~/.config/emdash/auth.json for that origin.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { emdashMcpToolsCall } from "./emdash-mcp-client.mjs";

const STAGING_DEFAULT = "https://staging.freedomtimes.news";
const PROD_DEFAULT = "https://freedomtimes.news";

function loadAuth() {
	const p = join(homedir(), ".config", "emdash", "auth.json");
	return JSON.parse(readFileSync(p, "utf8"));
}

function tokenFor(auth, baseUrl) {
	const key = baseUrl.replace(/\/$/, "");
	const t = auth[key]?.accessToken;
	if (!t) throw new Error(`No accessToken in auth.json for ${key}`);
	return t;
}

function resolveToken(baseUrl) {
	const u = baseUrl.replace(/\/$/, "");
	const envTok = process.env.EMDASH_MCP_TOKEN?.trim();
	if (envTok) return envTok;
	if (u === STAGING_DEFAULT.replace(/\/$/, "")) {
		const t = process.env.EMDASH_STAGING_TOKEN?.trim();
		if (t) return t;
	}
	if (u === PROD_DEFAULT.replace(/\/$/, "")) {
		const t = process.env.EMDASH_PRODUCTION_TOKEN?.trim();
		if (t) return t;
	}
	return tokenFor(loadAuth(), u);
}

function parseArgs(argv) {
	let url =
		process.env.EMDASH_MCP_URL?.replace(/\/$/, "") ||
		process.env.EMDASH_STAGING_URL?.replace(/\/$/, "") ||
		STAGING_DEFAULT;
	const rest = [];
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--url" && argv[i + 1]) {
			url = argv[++i].replace(/\/$/, "");
			continue;
		}
		rest.push(argv[i]);
	}
	const toolName = rest[0];
	const argsJson = rest[1] ?? "{}";
	return { url, toolName, argsJson };
}

async function main() {
	const { url, toolName, argsJson } = parseArgs(process.argv);
	if (!toolName) {
		console.error(
			"Usage: node web/scripts/emdash-mcp-tools-call.mjs [--url <origin>] <toolName> [argumentsJson]",
		);
		process.exit(1);
	}
	let toolArgs;
	try {
		toolArgs = JSON.parse(argsJson);
	} catch (e) {
		console.error("Invalid JSON arguments:", e.message);
		process.exit(1);
	}
	const token = resolveToken(url);
	const out = await emdashMcpToolsCall(url, token, toolName, toolArgs);
	console.log(JSON.stringify(out, null, 2));
}

await main();
