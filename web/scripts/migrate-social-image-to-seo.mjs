/**
 * Copy legacy `data.social_image` into `seo.image` when `seo.image` is empty (posts only).
 * After verifying staging, delete field `social_image` via MCP `schema_delete_field` (and prod parity).
 *
 * Usage (from repo root):
 *   node web/scripts/migrate-social-image-to-seo.mjs [--url https://staging.freedomtimes.news] [--dry-run]
 *
 * Auth: ~/.config/emdash/auth.json or EMDASH_MCP_TOKEN / EMDASH_STAGING_TOKEN.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { emdashMcpContentGet, emdashMcpToolsCall } from "./emdash-mcp-client.mjs";

const STAGING_DEFAULT = "https://staging.freedomtimes.news";

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

function parseArgs(argv) {
	let url = STAGING_DEFAULT;
	let dryRun = false;
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--url" && argv[i + 1]) {
			url = argv[++i].replace(/\/$/, "");
			continue;
		}
		if (argv[i] === "--dry-run") {
			dryRun = true;
			continue;
		}
	}
	return { url, dryRun };
}

async function listAllPublishedSlugs(baseUrl, token) {
	const slugs = [];
	let cursor = undefined;
	do {
		const page = await emdashMcpToolsCall(baseUrl, token, "content_list", {
			collection: "posts",
			status: "published",
			limit: 100,
			...(cursor ? { cursor } : {}),
		});
		const items = page.items;
		if (!Array.isArray(items)) break;
		for (const it of items) {
			const s = typeof it.slug === "string" ? it.slug : null;
			if (s) slugs.push(s);
		}
		cursor = page.nextCursor;
	} while (cursor);
	return slugs;
}

async function main() {
	const { url, dryRun } = parseArgs(process.argv);
	const envTok = process.env.EMDASH_MCP_TOKEN?.trim() || process.env.EMDASH_STAGING_TOKEN?.trim();
	const token = envTok || tokenFor(loadAuth(), url);

	const slugs = await listAllPublishedSlugs(url, token);
	let updated = 0;
	let skipped = 0;

	for (const slug of slugs) {
		const { item, _rev } = await emdashMcpContentGet(url, token, {
			collection: "posts",
			id: slug,
		});
		const seo = item.seo && typeof item.seo === "object" ? { ...item.seo } : {};
		const img0 = seo.image;
		const hasSeoImage =
			img0 != null
			&& img0 !== ""
			&& !(typeof img0 === "object" && img0 !== null && Object.keys(img0).length === 0);
		const social = item.data?.social_image ?? item.data?.socialImage;
		if (hasSeoImage || social == null) {
			skipped++;
			continue;
		}
		const nextSeo = { ...seo, image: social };
		if (dryRun) {
			console.log(`[dry-run] would set seo.image from social_image: ${slug}`);
			updated++;
			continue;
		}
		await emdashMcpToolsCall(url, token, "content_update", {
			collection: "posts",
			id: slug,
			seo: nextSeo,
			_rev,
		});
		console.log(`updated seo.image: ${slug}`);
		updated++;
	}

	console.log(JSON.stringify({ ok: true, url, total: slugs.length, updated, skipped, dryRun }, null, 2));
}

await main();
