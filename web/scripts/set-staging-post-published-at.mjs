/**
 * Set publishedAt on a staging post via EmDash REST PUT (not a collection field).
 *
 * Usage (from repo root):
 *   node web/scripts/set-staging-post-published-at.mjs posts <slug> [iso8601]
 *
 * Default base URL: https://staging.freedomtimes.news
 * Default time: now (UTC ISO string)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const STAGING_DEFAULT = "https://staging.freedomtimes.news";
const baseUrl = (process.env.EMDASH_STAGING_URL || STAGING_DEFAULT).replace(/\/$/, "");
const collection = process.argv[2] || "posts";
const slug = process.argv[3];
const isoArg = process.argv[4]?.trim();
if (!slug) {
	console.error("Usage: node web/scripts/set-staging-post-published-at.mjs <collection> <slug> [iso8601]");
	process.exit(1);
}
const publishedAt = isoArg && isoArg.length > 0 ? isoArg : new Date().toISOString();

function loadToken() {
	const envTok = process.env.EMDASH_STAGING_TOKEN?.trim();
	if (baseUrl.replace(/\/$/, "") === STAGING_DEFAULT.replace(/\/$/, "") && envTok) return envTok;
	const p = join(homedir(), ".config", "emdash", "auth.json");
	const auth = JSON.parse(readFileSync(p, "utf8"));
	const t = auth[baseUrl]?.accessToken;
	if (!t) throw new Error(`No accessToken in auth.json for ${baseUrl} (set EMDASH_STAGING_TOKEN for staging)`);
	return t;
}

function apiUrl(path) {
	return `${baseUrl}/_emdash/api${path}`;
}

async function apiGetJson(url, token) {
	const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
	const txt = await r.text();
	const j = JSON.parse(txt);
	if (!r.ok) throw new Error(`${r.status} GET ${url}: ${j?.error?.message ?? txt}`);
	return j;
}

async function apiPutJson(url, token, body) {
	const r = await fetch(url, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const txt = await r.text();
	const j = JSON.parse(txt);
	if (!r.ok) throw new Error(`${r.status} PUT ${url}: ${j?.error?.message ?? txt}`);
	return j;
}

const token = loadToken();
const path = `/content/${collection}/${encodeURIComponent(slug)}`;
const cur = await apiGetJson(apiUrl(path), token);
const rev = cur.data?._rev;
if (!rev) throw new Error("Missing _rev on content GET");

const out = await apiPutJson(apiUrl(path), token, {
	_rev: rev,
	publishedAt,
});

console.log(JSON.stringify({ ok: true, baseUrl, collection, slug, publishedAt, responseKeys: Object.keys(out) }, null, 2));
