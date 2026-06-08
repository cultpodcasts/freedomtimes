/**
 * Classify `data.content` for an EmDash entry via MCP `content_get` (Portable Text truth).
 *
 * Usage:
 *   node web/scripts/canary-emdash-content-shape.mjs <baseUrl> <collection> <slug>
 *
 * Ignores legacy `--mcp` / `--published` flags if passed (MCP-only canary).
 *
 * Requires an accessToken in ~/.config/emdash/auth.json for **baseUrl**.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { emdashMcpContentGet } from "./emdash-mcp-client.mjs";

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

const [, , baseUrl, collection, slug] = process.argv;
if (!baseUrl || !collection || !slug) {
	console.error("Usage: node web/scripts/canary-emdash-content-shape.mjs <baseUrl> <collection> <slug>");
	process.exit(1);
}

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
