/**
 * Merge `item.data` from MCP `content_get` with a local JSON patch, then
 * `emdash content update` + `content publish` on staging (Portable Text-safe).
 *
 * Patch file: `{ "data": { ...fields to overlay } }` or `{ "slug", "data" }`.
 * Shallow-merge at the `data` level: patch keys override live keys.
 *
 * Usage (from repo root):
 *   node web/scripts/merge-staging-post-from-patch.mjs posts <slug> [path/to/patch.json]
 *
 * Default patch path: `web/.emdash/article-patches/<slug>.json`
 * Default base URL: https://staging.freedomtimes.news
 *
 * Requires ~/.config/emdash/auth.json with accessToken for that URL, or set
 * `EMDASH_STAGING_TOKEN` (when `EMDASH_STAGING_URL` / default is staging) to override.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { emdashMcpContentGet } from "./emdash-mcp-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "..");
const STAGING_DEFAULT = "https://staging.freedomtimes.news";

function loadAuth() {
	const p = join(homedir(), ".config", "emdash", "auth.json");
	return JSON.parse(readFileSync(p, "utf8"));
}

function tokenFor(auth, baseUrl) {
	const t = auth[baseUrl]?.accessToken;
	if (!t) throw new Error(`No accessToken in auth.json for ${baseUrl}`);
	return t;
}

function apiUrl(base, path) {
	return `${base.replace(/\/$/, "")}/_emdash/api${path}`;
}

async function apiGetJson(url, token) {
	const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
	const txt = await r.text();
	const j = JSON.parse(txt);
	if (!r.ok) throw new Error(`${r.status} GET ${url}: ${j?.error?.message ?? txt}`);
	return j;
}

async function main() {
	const collection = process.argv[2] || "posts";
	const slug = process.argv[3];
	if (!slug) {
		console.error("Usage: node web/scripts/merge-staging-post-from-patch.mjs <collection> <slug> [patch.json]");
		process.exit(1);
	}
	const baseUrl = process.env.EMDASH_STAGING_URL || STAGING_DEFAULT;
	const patchPath =
		process.argv[4] || join(webDir, ".emdash", "article-patches", `${slug}.json`);

	const auth = loadAuth();
	const token =
		(baseUrl.replace(/\/$/, "") === STAGING_DEFAULT.replace(/\/$/, "") &&
			process.env.EMDASH_STAGING_TOKEN?.trim()) ||
		tokenFor(auth, baseUrl);

	let item;
	let rev;
	try {
		const out = await emdashMcpContentGet(baseUrl, token, { collection, id: slug });
		item = out.item;
		rev = out._rev;
	} catch (mcpErr) {
		// MCP and REST tokens differ in some setups; REST matches `emdash content update`.
		console.warn(`MCP content_get skipped (${mcpErr?.message ?? mcpErr}); using REST GET for current item.`);
		const g = await apiGetJson(apiUrl(baseUrl, `/content/${collection}/${encodeURIComponent(slug)}`), token);
		if (!g?.data || typeof g.data !== "object") {
			throw new Error("REST content GET returned no data object");
		}
		item = { data: g.data };
		rev = g.data._rev;
	}
	if (rev == null || rev === "") {
		const g = await apiGetJson(apiUrl(baseUrl, `/content/${collection}/${encodeURIComponent(slug)}`), token);
		rev = g.data?._rev;
	}
	if (!rev) throw new Error("Could not resolve _rev for content update");

	const patchRoot = JSON.parse(readFileSync(patchPath, "utf8"));
	const overlay = patchRoot.data ?? patchRoot;
	if (!overlay || typeof overlay !== "object") {
		throw new Error("Patch must contain a `data` object or be a data-shaped object");
	}

	const mergedData = { ...item.data, ...overlay };

	if (
		Array.isArray(overlay.content) &&
		Array.isArray(item.data.content) &&
		overlay.content.length < item.data.content.length &&
		process.env.MERGE_STAGING_ALLOW_CONTENT_SHRINK !== "1"
	) {
		console.error(
			`Refusing merge: patch \`data.content\` has ${overlay.content.length} blocks but live has ${item.data.content.length}. ` +
				`Your patch may be an old export—re-export the full post (MCP \`content_get\`) then edit, or set MERGE_STAGING_ALLOW_CONTENT_SHRINK=1 to override.`,
		);
		process.exit(1);
	}

	const tmpDir = join(webDir, ".tmp");
	if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
	const tmpFile = join(tmpDir, `merge-push-${collection}-${slug}-data.json`);
	writeFileSync(tmpFile, JSON.stringify(mergedData), "utf8");

	const up = spawnSync(
		"npx",
		["emdash", "content", "update", collection, slug, "--rev", String(rev), "--file", tmpFile, "-u", baseUrl, "-t", token, "--json"],
		{ cwd: webDir, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 },
	);
	if (up.status !== 0) {
		console.error(up.stderr || up.stdout);
		process.exit(up.status ?? 1);
	}

	const pub = spawnSync(
		"npx",
		["emdash", "content", "publish", collection, slug, "-u", baseUrl, "-t", token, "--json"],
		{ cwd: webDir, encoding: "utf8", shell: true },
	);
	if (pub.status !== 0) {
		console.error(pub.stderr || pub.stdout);
		process.exit(pub.status ?? 1);
	}

	console.log(JSON.stringify({ ok: true, baseUrl, collection, slug, patchPath }, null, 2));
}

main().catch((e) => {
	console.error(e?.message ?? e);
	process.exit(1);
});
