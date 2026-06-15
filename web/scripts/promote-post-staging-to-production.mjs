/**
 * Promote a single published EmDash entry from staging to production:
 * - Staging snapshot: **MCP `content_get` only** so `data.content` stays Portable Text arrays
 *   (never `npx emdash content get`, which can stringify PT in JSON).
 * - Production: **MCP** `content_create` / `content_update` / `content_publish` (not CLI).
 * - **Same slug on staging and production** — this script never renames; `<slug>` must match staging.
 * - featured_image / social_image: if production lacks staging media id, download from
 *   staging public file URL, upload to production, patch `data`.
 * - bylines: staging `primaryBylineId` → MCP `content_update` with `bylines: [{ bylineId }]`.
 *
 * SAFETY: production `content_publish` sends push notifications to subscribers.
 * Requires `--i-understand-production` — pass only when the operator explicitly requested
 * production publish in the current session.
 *
 * Usage (from repo root):
 *   node web/scripts/promote-post-staging-to-production.mjs posts <slug> --i-understand-production
 *
 * Requires ~/.config/emdash/auth.json with accessToken for both URLs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { emdashMcpContentGet, emdashMcpToolsCall } from "./emdash-mcp-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STAGING_DEFAULT = "https://staging.freedomtimes.news";
const PROD_DEFAULT = "https://freedomtimes.news";
const PRODUCTION_FLAG = "--i-understand-production";

function loadAuth() {
	const p = join(homedir(), ".config", "emdash", "auth.json");
	const j = JSON.parse(readFileSync(p, "utf8"));
	return j;
}

function tokenFor(auth, baseUrl) {
	const isStaging = /staging\./i.test(baseUrl);
	const envToken = (
		isStaging
			? process.env.EMDASH_STAGING_PAT ?? process.env.EMDASH_STAGING_TOKEN
			: process.env.EMDASH_PRODUCTION_PAT
				?? process.env.EMDASH_PRODUCTION_TOKEN
				?? process.env.FREEDOMTIMES_PRODUCTION_EMDASH_PAT
	)?.trim();
	if (envToken) return envToken;
	const t = auth[baseUrl]?.accessToken;
	if (!t) {
		throw new Error(
			`No token for ${baseUrl}. Set EMDASH_${isStaging ? "STAGING" : "PRODUCTION"}_PAT or run emdash login.`,
		);
	}
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
			caption:
				(prev?.meta && typeof prev.meta === "object" ? prev.meta.caption : null)
				?? item.caption
				?? null,
			blurhash: item.blurhash ?? prev?.meta?.blurhash ?? null,
			dominantColor: item.dominantColor ?? prev?.meta?.dominantColor ?? null,
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

async function prodEntryExists(prodUrl, prodToken, collection, slug) {
	try {
		await apiGetJson(apiUrl(prodUrl, `/content/${collection}/${encodeURIComponent(slug)}`), prodToken);
		return true;
	} catch (e) {
		const msg = String(e?.message ?? e);
		if (/\b404\b/.test(msg)) return false;
		throw e;
	}
}

/** `_rev` for optimistic concurrency (MCP root or REST `data._rev`). */
async function prodContentRev(prodUrl, prodToken, collection, slug) {
	try {
		const o = await emdashMcpContentGet(prodUrl, prodToken, { collection, id: slug });
		if (o._rev) return o._rev;
	} catch {
		/* fall through */
	}
	const g = await apiGetJson(apiUrl(prodUrl, `/content/${collection}/${encodeURIComponent(slug)}`), prodToken);
	const r = g.data?._rev;
	if (!r) throw new Error("Could not resolve production _rev");
	return r;
}

function defaultSeoPayload() {
	return { title: null, description: null, image: null, canonical: null, noIndex: false };
}

/** Minimal document shape from MCP `content_get` item. */
function stagingDocFromMcpItem(collection, item) {
	return {
		id: item.id,
		type: item.type ?? collection,
		slug: item.slug,
		status: item.status,
		data: item.data,
		seo: item.seo && typeof item.seo === "object" ? item.seo : null,
		primaryBylineId: item.primaryBylineId ?? null,
	};
}

function isPortableTextShape(content) {
	return content === null || content === undefined || Array.isArray(content);
}

const MEDIA_FILE_PATH_RE = /\/_emdash\/api\/media\/file\/([^/?#]+)/;

function storageKeyFromMediaPath(value) {
	if (typeof value !== "string") return null;
	const m = value.trim().match(MEDIA_FILE_PATH_RE);
	return m ? decodeURIComponent(m[1]) : null;
}

function mediaFilePath(storageKey) {
	return `/_emdash/api/media/file/${storageKey}`;
}

/** Upload staging file by storageKey to production; cache by staging storageKey. */
async function ensureProdMediaFile(stagingUrl, prodUrl, prodToken, storageKey, filename, alt, cache) {
	if (cache.has(storageKey)) return cache.get(storageKey);
	const buf = await downloadStagingMediaFile(stagingUrl, storageKey);
	const uploaded = await uploadMediaProd(
		prodUrl,
		prodToken,
		buf,
		filename || storageKey.split("/").pop() || "promoted-media.jpg",
		alt ?? "",
	);
	const prodPath = mediaFilePath(uploaded.storageKey);
	cache.set(storageKey, { prodPath, item: uploaded });
	return cache.get(storageKey);
}

async function remapPortableTextMedia(stagingUrl, prodUrl, prodToken, content, cache) {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (block?._type !== "image" || !block.asset || typeof block.asset !== "object") continue;
		const sk = storageKeyFromMediaPath(block.asset.url);
		if (!sk) continue;
		const { prodPath } = await ensureProdMediaFile(
			stagingUrl,
			prodUrl,
			prodToken,
			sk,
			`${sk.split(".")[0] || "inline"}.${sk.includes(".") ? sk.split(".").pop() : "jpg"}`,
			block.alt ?? "",
			cache,
		);
		block.asset.url = prodPath;
	}
}

async function remapSeoImageString(stagingUrl, prodUrl, prodToken, payloadSeo, cache) {
	const img = payloadSeo?.image;
	if (typeof img !== "string") return;
	const sk = storageKeyFromMediaPath(img);
	if (!sk) return;
	const { prodPath } = await ensureProdMediaFile(
		stagingUrl,
		prodUrl,
		prodToken,
		sk,
		"promoted-og.png",
		"",
		cache,
	);
	payloadSeo.image = prodPath;
}

async function main() {
	const rawArgs = process.argv.slice(2);
	if (!rawArgs.includes(PRODUCTION_FLAG)) {
		console.error(
			`REFUSED: production promote publishes to ${PROD_DEFAULT} and sends push notifications.\n` +
				`Pass ${PRODUCTION_FLAG} only when the operator explicitly requested production publish.\n` +
				`Usage: node web/scripts/promote-post-staging-to-production.mjs <collection> <slug> ${PRODUCTION_FLAG}`,
		);
		process.exit(1);
	}
	const positional = rawArgs.filter((a) => a !== PRODUCTION_FLAG);
	const collection = positional[0] || "posts";
	const slug = positional[1];
	if (!slug) {
		console.error(
			`Usage: node web/scripts/promote-post-staging-to-production.mjs <collection> <slug> ${PRODUCTION_FLAG}`,
		);
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

	// 1) Staging snapshot: MCP only (preserves Portable Text in data.content).
	let stagingDoc;
	let stagingFetchMeta = { source: "mcp" };
	try {
		const { item } = await emdashMcpContentGet(stagingUrl, stagingToken, { collection, id: slug });
		stagingDoc = stagingDocFromMcpItem(collection, item);
		if (stagingDoc.slug && stagingDoc.slug !== slug) {
			throw new Error(
				`Slug mismatch: argument "${slug}" but staging post slug is "${stagingDoc.slug}". ` +
					`Promote uses identical slug on staging and production — do not rename.`,
			);
		}
		const c = stagingDoc.data?.content;
		if (!isPortableTextShape(c)) {
			throw new Error(`MCP returned non-array data.content (${typeof c})`);
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
	delete payloadData._rev;

	let payloadSeo =
		stagingDoc.seo && typeof stagingDoc.seo === "object"
			? structuredClone(stagingDoc.seo)
			: defaultSeoPayload();

	const mediaCache = new Map();

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

	// 2b) Remap social_image (legacy field): staging media ids are not valid in prod
	const si0 = payloadData.social_image;
	if (si0 && typeof si0 === "object" && si0.id) {
		const ok = await mediaExists(prodUrl, prodToken, si0.id);
		if (!ok) {
			const sk = si0.meta?.storageKey;
			if (!sk) throw new Error("social_image missing meta.storageKey; cannot download from staging");
			const buf = await downloadStagingMediaFile(stagingUrl, sk);
			const filename = si0.filename || "promoted-social.png";
			const uploaded = await uploadMediaProd(prodUrl, prodToken, buf, filename, si0.alt ?? "");
			payloadData.social_image = featuredFromUploadItem(uploaded, si0);
		}
	}

	// 2c) Remap seo.image (OG / share card): same as social_image
	const ogi0 = payloadSeo.image;
	if (ogi0 && typeof ogi0 === "object" && ogi0.id) {
		const ok = await mediaExists(prodUrl, prodToken, ogi0.id);
		if (!ok) {
			const sk = ogi0.meta?.storageKey;
			if (!sk) throw new Error("seo.image missing meta.storageKey; cannot download from staging");
			const buf = await downloadStagingMediaFile(stagingUrl, sk);
			const filename = ogi0.filename || "promoted-og.png";
			const uploaded = await uploadMediaProd(prodUrl, prodToken, buf, filename, ogi0.alt ?? "");
			payloadSeo.image = featuredFromUploadItem(uploaded, ogi0);
		}
	}

	// 2d) Prefer seo.image; copy legacy social_image into seo.image when SEO image is empty
	if ((payloadSeo.image === null || payloadSeo.image === undefined) && payloadData.social_image != null) {
		payloadSeo.image = structuredClone(payloadData.social_image);
	}

	// 2e) Inline Portable Text images (staging /file/ paths → production uploads)
	await remapPortableTextMedia(stagingUrl, prodUrl, prodToken, payloadData.content, mediaCache);

	// 2f) seo.image as admin file path string (not MediaReference object)
	await remapSeoImageString(stagingUrl, prodUrl, prodToken, payloadSeo, mediaCache);

	writeFileSync(dataPath, JSON.stringify(payloadData), "utf8");

	// 3) Create or update production (MCP)
	const exists = await prodEntryExists(prodUrl, prodToken, collection, slug);
	if (!exists) {
		await emdashMcpToolsCall(prodUrl, prodToken, "content_create", {
			collection,
			slug,
			data: payloadData,
			status: "draft",
		});
		const revSeo = await prodContentRev(prodUrl, prodToken, collection, slug);
		await emdashMcpToolsCall(prodUrl, prodToken, "content_update", {
			collection,
			id: slug,
			seo: payloadSeo,
			_rev: revSeo,
		});
	} else {
		const rev = await prodContentRev(prodUrl, prodToken, collection, slug);
		await emdashMcpToolsCall(prodUrl, prodToken, "content_update", {
			collection,
			id: slug,
			data: payloadData,
			seo: payloadSeo,
			_rev: rev,
		});
	}

	// 4) Bylines (MCP content_update)
	const bylineId = stagingDoc.primaryBylineId;
	if (bylineId) {
		const revBl = await prodContentRev(prodUrl, prodToken, collection, slug);
		await emdashMcpToolsCall(prodUrl, prodToken, "content_update", {
			collection,
			id: slug,
			bylines: [{ bylineId }],
			_rev: revBl,
		});
	}

	// 5) Publish (MCP)
	await emdashMcpToolsCall(prodUrl, prodToken, "content_publish", { collection, id: slug });

	// 6) Verify (MCP content_get)
	const { item: outItem } = await emdashMcpContentGet(prodUrl, prodToken, { collection, id: slug });
	if (outItem.status !== "published") {
		throw new Error(`Expected published status after promote; got ${outItem.status}`);
	}
	console.log(
		JSON.stringify(
			{
				ok: true,
				slug: outItem.slug,
				primaryBylineId: outItem.primaryBylineId ?? null,
				byline: outItem.byline?.displayName ?? null,
				featuredMediaId: outItem.data?.featured_image?.id ?? null,
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
