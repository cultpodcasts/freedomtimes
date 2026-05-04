/**
 * Promote a single published EmDash entry from staging to production:
 * - Staging `data` snapshot: **MCP `content_get` by default** so `portableText` fields
 *   (e.g. `data.content`) stay **Portable Text arrays** — `npx emdash content get --published --json`
 *   often serializes rich text to a **markdown string** in JSON even when Turso holds PT.
 * - Fallback: CLI export if MCP fails or `PROMOTE_STAGING_SOURCE=cli` (degraded for PT).
 * - content create/update using `data`-only payload (required by emdash CLI)
 * - featured_image: if production does not have the staging media id, download from
 *   staging public file URL and re-upload to production, then patch `data.featured_image`
 * - bylines: if staging has `primaryBylineId`, attach via PUT `bylines: [{ bylineId }]`
 *   (primaryBylineId alone is ignored by the API; see emdash handleContentUpdate)
 *
 * Usage (from repo root):
 *   node web/scripts/promote-post-staging-to-production.mjs posts my-slug
 *
 * Env:
 *   PROMOTE_STAGING_SOURCE — `mcp` | `cli` | `auto` (default `auto`: MCP then CLI).
 *
 * Requires ~/.config/emdash/auth.json with accessToken for both URLs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { emdashMcpContentGet } from "./emdash-mcp-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STAGING_DEFAULT = "https://staging.freedomtimes.news";
const PROD_DEFAULT = "https://freedomtimes.news";

function loadAuth() {
	const p = join(homedir(), ".config", "emdash", "auth.json");
	const j = JSON.parse(readFileSync(p, "utf8"));
	return j;
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
	let j;
	try {
		j = JSON.parse(txt);
	} catch {
		throw new Error(`Non-JSON ${r.status} ${url}: ${txt.slice(0, 200)}`);
	}
	if (!r.ok) {
		const msg = j?.error?.message ?? txt;
		throw new Error(`${r.status} GET ${url}: ${msg}`);
	}
	return j;
}

async function apiSend(method, url, token, body) {
	const r = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const txt = await r.text();
	let j;
	try {
		j = JSON.parse(txt);
	} catch {
		throw new Error(`Non-JSON ${r.status} ${method} ${url}: ${txt.slice(0, 200)}`);
	}
	if (!r.ok) {
		const msg = j?.error?.message ?? txt;
		throw new Error(`${r.status} ${method} ${url}: ${msg}`);
	}
	return j;
}

async function mediaExists(baseUrl, token, id) {
	const r = await fetch(apiUrl(baseUrl, `/media/${encodeURIComponent(id)}`), {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
	});
	return r.ok;
}

/** Build featured_image object shape expected in content `data` from upload API item */
function featuredFromUploadItem(item, prev) {
	return {
		id: item.id,
		provider: "local",
		filename: item.filename,
		mimeType: item.mimeType,
		width: prev?.width ?? item.width ?? null,
		height: prev?.height ?? item.height ?? null,
		alt: prev?.alt ?? item.alt ?? "",
		meta: {
			storageKey: item.storageKey,
			caption: item.caption ?? null,
			blurhash: item.blurhash ?? null,
			dominantColor: item.dominantColor ?? null,
		},
	};
}

async function downloadStagingMediaFile(stagingBase, storageKey) {
	const u = `${stagingBase.replace(/\/$/, "")}/_emdash/api/media/file/${encodeURIComponent(storageKey)}`;
	const r = await fetch(u);
	if (!r.ok) throw new Error(`Failed to download staging media file ${u} (${r.status})`);
	return Buffer.from(await r.arrayBuffer());
}

function guessImageMime(filename) {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/jpeg";
}

async function uploadMediaProd(prodBase, prodToken, buf, filename, alt) {
	const form = new FormData();
	const mime = guessImageMime(filename);
	form.append("file", new Blob([buf], { type: mime }), filename);
	if (alt !== undefined && alt !== null) form.append("alt", alt);
	const url = apiUrl(prodBase, "/media");
	const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${prodToken}` }, body: form });
	const txt = await r.text();
	const j = JSON.parse(txt);
	if (!r.ok) throw new Error(`${r.status} POST media: ${j?.error?.message ?? txt}`);
	return j.data.item;
}

function runNpx(webDir, args) {
	const res = spawnSync("npx", args, { cwd: webDir, encoding: "utf8", shell: true });
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Minimal document shape for this script (matches CLI `content get --json` fields we use). */
function stagingDocFromMcpItem(collection, item) {
	return {
		id: item.id,
		type: item.type ?? collection,
		slug: item.slug,
		status: item.status,
		data: item.data,
		primaryBylineId: item.primaryBylineId ?? null,
	};
}

function isPortableTextShape(content) {
	return content === null || content === undefined || Array.isArray(content);
}

/** MCP failed in `auto` mode: staging export will use CLI JSON — can stringify PT to markdown. */
function logSeverePromoteCliFallback(mcpErr) {
	const detail = String(mcpErr?.message ?? mcpErr).replace(/\s+/g, " ").trim().slice(0, 500);
	const bar = "!".repeat(78);
	const row = (s) => `!!! ${s.slice(0, 72).padEnd(72, " ")} !!!`;
	console.error("");
	console.error(bar);
	console.error(row("SEVERE WARNING: STAGING SNAPSHOT IS FROM CLI FALLBACK — NOT MCP"));
	console.error(bar);
	console.error(row("emdash content get --published --json often turns portableText"));
	console.error(row("into a MARKDOWN STRING. Production may get data.content as a string,"));
	console.error(row("NOT a Portable Text block array — site/renderers can diverge from staging."));
	console.error(row("Fix: refresh ~/.config/emdash/auth.json (emdash login), check PAT,"));
	console.error(row("network, and Accept header; then re-run with PROMOTE_STAGING_SOURCE=mcp."));
	console.error(row(`MCP failure (first 500 chars): ${detail || "(no message)"}`));
	console.error(bar);
	console.error(row("Promotion CONTINUES — verify Turso/json_type(content) or MCP after."));
	console.error(bar);
	console.error("");
}

async function fetchStagingDocFromCli(webDir, stagingUrl, stagingToken, collection, slug) {
	const getPub = runNpx(webDir, [
		"emdash",
		"content",
		"get",
		collection,
		slug,
		"--published",
		"-u",
		stagingUrl,
		"-t",
		stagingToken,
		"--json",
	]);
	if (getPub.status !== 0) {
		throw new Error(getPub.stderr || getPub.stdout || "emdash content get failed");
	}
	return JSON.parse(getPub.stdout);
}

async function main() {
	const collection = process.argv[2] || "posts";
	const slug = process.argv[3];
	if (!slug) {
		console.error("Usage: node web/scripts/promote-post-staging-to-production.mjs <collection> <slug>");
		process.exit(1);
	}

	const stagingUrl = process.env.EMDASH_STAGING_URL || STAGING_DEFAULT;
	const prodUrl = process.env.EMDASH_PRODUCTION_URL || PROD_DEFAULT;
	const auth = loadAuth();
	const stagingToken = tokenFor(auth, stagingUrl);
	const prodToken = tokenFor(auth, prodUrl);

	const repoRoot = join(__dirname, "..", "..");
	const webDir = join(repoRoot, "web");
	const tmpDir = join(webDir, ".tmp");
	if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

	const fullPath = join(tmpDir, `promote-${collection}-${slug}-full.json`);
	const dataPath = join(tmpDir, `promote-${collection}-${slug}-data.json`);

	const sourceMode = (process.env.PROMOTE_STAGING_SOURCE || "auto").toLowerCase();
	if (!["mcp", "cli", "auto"].includes(sourceMode)) {
		console.error("PROMOTE_STAGING_SOURCE must be mcp, cli, or auto");
		process.exit(1);
	}

	// 1) Staging snapshot: prefer MCP so `data.content` stays Portable Text (CLI JSON often stringifies PT).
	let stagingDoc;
	let stagingFetchMeta = { source: "unknown" };
	try {
		if (sourceMode === "cli") {
			stagingDoc = await fetchStagingDocFromCli(webDir, stagingUrl, stagingToken, collection, slug);
			stagingFetchMeta = { source: "cli" };
		} else {
			try {
				const { item } = await emdashMcpContentGet(stagingUrl, stagingToken, { collection, id: slug });
				stagingDoc = stagingDocFromMcpItem(collection, item);
				const c = stagingDoc.data?.content;
				if (!isPortableTextShape(c)) {
					throw new Error(`MCP returned non-array data.content (${typeof c})`);
				}
				stagingFetchMeta = { source: "mcp" };
			} catch (mcpErr) {
				if (sourceMode === "mcp") {
					throw mcpErr;
				}
				logSeverePromoteCliFallback(mcpErr);
				stagingDoc = await fetchStagingDocFromCli(webDir, stagingUrl, stagingToken, collection, slug);
				stagingFetchMeta = { source: "cli", mcpError: String(mcpErr?.message ?? mcpErr) };
			}
		}
	} catch (e) {
		console.error(e?.message ?? e);
		process.exit(1);
	}

	writeFileSync(
		fullPath,
		JSON.stringify({ ...stagingDoc, _promoteStagingFetch: stagingFetchMeta }, null, 2),
		"utf8",
	);
	/** Deep clone so we never mutate the staging snapshot on disk */
	const payloadData = structuredClone(stagingDoc.data);

	// 2) Remap featured_image to production media *before* create/update (staging ids are not valid in prod)
	const fi0 = payloadData.featured_image;
	if (fi0 && typeof fi0 === "object" && fi0.id) {
		const ok = await mediaExists(prodUrl, prodToken, fi0.id);
		if (!ok) {
			const sk = fi0.meta?.storageKey;
			if (!sk) throw new Error("featured_image missing meta.storageKey; cannot download from staging");
			const buf = await downloadStagingMediaFile(stagingUrl, sk);
			const filename = fi0.filename || "promoted-featured.jpg";
			const uploaded = await uploadMediaProd(prodUrl, prodToken, buf, filename, fi0.alt ?? "");
			payloadData.featured_image = featuredFromUploadItem(uploaded, fi0);
		}
	}

	writeFileSync(dataPath, JSON.stringify(payloadData), "utf8");

	// 3) Probe production
	const probe = runNpx(webDir, ["emdash", "content", "get", collection, slug, "-u", prodUrl, "-t", prodToken, "--json"]);
	const exists = probe.status === 0;

	if (!exists) {
		const cr = runNpx(webDir, [
			"emdash",
			"content",
			"create",
			collection,
			"--slug",
			slug,
			"--file",
			dataPath,
			"-u",
			prodUrl,
			"-t",
			prodToken,
			"--json",
		]);
		if (cr.status !== 0) {
			console.error(cr.stderr || cr.stdout);
			process.exit(1);
		}
	} else {
		const prodDraft = JSON.parse(probe.stdout);
		const rev = prodDraft._rev || prodDraft.rev;
		if (!rev) throw new Error("Production item missing _rev");
		const up = runNpx(webDir, [
			"emdash",
			"content",
			"update",
			collection,
			slug,
			"--rev",
			rev,
			"--file",
			dataPath,
			"-u",
			prodUrl,
			"-t",
			prodToken,
			"--json",
		]);
		if (up.status !== 0) {
			console.error(up.stderr || up.stdout);
			process.exit(1);
		}
	}

	// 4) Bylines: use junction API shape
	const bylineId = stagingDoc.primaryBylineId;
	if (bylineId) {
		const g3 = await apiGetJson(apiUrl(prodUrl, `/content/${collection}/${encodeURIComponent(slug)}`), prodToken);
		const rev3 = g3.data._rev;
		await apiSend("PUT", apiUrl(prodUrl, `/content/${collection}/${encodeURIComponent(slug)}`), prodToken, {
			_rev: rev3,
			bylines: [{ bylineId }],
		});
	}

	// 5) Publish
	const pub = runNpx(webDir, ["emdash", "content", "publish", collection, slug, "-u", prodUrl, "-t", prodToken, "--json"]);
	if (pub.status !== 0) {
		console.error(pub.stderr || pub.stdout);
		process.exit(1);
	}

	// 6) Verify
	const ver = runNpx(webDir, [
		"emdash",
		"content",
		"get",
		collection,
		slug,
		"--published",
		"-u",
		prodUrl,
		"-t",
		prodToken,
		"--json",
	]);
	if (ver.status !== 0) {
		console.error(ver.stderr);
		process.exit(1);
	}
	const out = JSON.parse(ver.stdout);
	console.log(
		JSON.stringify(
			{
				ok: true,
				slug: out.slug,
				primaryBylineId: out.primaryBylineId,
				byline: out.byline?.displayName ?? null,
				featuredMediaId: out.data?.featured_image?.id ?? null,
				url: `${prodUrl}/${slug}`,
			},
			null,
			2,
		),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
