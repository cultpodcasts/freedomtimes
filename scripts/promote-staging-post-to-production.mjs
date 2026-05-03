/**
 * Promote a published post from staging to production via EmDash MCP (HTTP JSON-RPC).
 * Requires:
 *   - Staging token in ~/.config/emdash/auth.json (or EMDASH_STAGING_TOKEN)
 *   - Production token: ~/.config/emdash/auth.json entry https://freedomtimes.news, or
 *     FREEDOMTIMES_PRODUCTION_EMDASH_PAT / EMDASH_PRODUCTION_TOKEN (PAT or OAuth access token)
 *
 * Usage (repo root):
 *   node scripts/promote-staging-post-to-production.mjs breton-mayor-treogan-investigation-review
 *
 * Featured image: downloads from staging media URL, then runs `npx emdash media upload` against production
 * (MCP has no binary upload). Requires `npx` + web/ emdash on PATH from repo root.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const WEB = path.join(REPO_ROOT, "web");

const STAGING_MCP = "https://staging.freedomtimes.news/_emdash/api/mcp";
const STAGING_ORIGIN = "https://staging.freedomtimes.news";
const PRODUCTION_MCP = "https://freedomtimes.news/_emdash/api/mcp";

const SLUG = process.argv[2] || "breton-mayor-treogan-investigation-review";

function parseSse(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  throw new Error("No SSE data in MCP response");
}

async function mcpRpc(mcpUrl, token, method, params, id) {
  const r = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "MCP-Protocol-Version": "2025-03-26",
      "X-EmDash-Request": "1",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await r.text();
  if (r.status !== 200) throw new Error(`MCP ${r.status}: ${text}`);
  return parseSse(text);
}

async function mcpTool(mcpUrl, token, name, args, id) {
  const out = await mcpRpc(mcpUrl, token, "tools/call", { name, arguments: args }, id);
  if (out.error) throw new Error(JSON.stringify(out.error));
  const chunk = out.result?.content?.[0];
  if (out.result?.isError) throw new Error(chunk?.text || "MCP tool error");
  if (chunk?.type !== "text") throw new Error(JSON.stringify(out.result));
  return JSON.parse(chunk.text);
}

async function mcpToolAllowError(mcpUrl, token, name, args, id) {
  const out = await mcpRpc(mcpUrl, token, "tools/call", { name, arguments: args }, id);
  if (out.error) return { ok: false, error: out.error };
  const chunk = out.result?.content?.[0];
  if (out.result?.isError) return { ok: false, error: chunk?.text || "MCP tool error" };
  if (chunk?.type !== "text") return { ok: false, error: JSON.stringify(out.result) };
  return { ok: true, value: JSON.parse(chunk.text) };
}

function readStagingToken() {
  if (process.env.EMDASH_STAGING_TOKEN?.trim()) return process.env.EMDASH_STAGING_TOKEN.trim();
  const p = path.join(process.env.USERPROFILE || process.env.HOME, ".config", "emdash", "auth.json");
  const auth = JSON.parse(fs.readFileSync(p, "utf8"));
  return auth["https://staging.freedomtimes.news"]?.accessToken;
}

function readProductionToken() {
  const fromEnv =
    process.env.FREEDOMTIMES_PRODUCTION_EMDASH_PAT?.trim() ||
    process.env.EMDASH_PRODUCTION_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const p = path.join(process.env.USERPROFILE || process.env.HOME, ".config", "emdash", "auth.json");
  const auth = JSON.parse(fs.readFileSync(p, "utf8"));
  const t = auth["https://freedomtimes.news"]?.accessToken;
  if (!t) {
    throw new Error(
      "No production token: run emdash login -u https://freedomtimes.news or set EMDASH_PRODUCTION_TOKEN.",
    );
  }
  return t;
}

async function init(mcpUrl, token) {
  await mcpRpc(mcpUrl, token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "promote-staging-post-to-production", version: "1" },
  }, 0);
}

async function main() {
  const stagingTok = readStagingToken();
  const prodTok = readProductionToken();

  await init(STAGING_MCP, stagingTok);
  await init(PRODUCTION_MCP, prodTok);

  const src = await mcpTool(STAGING_MCP, stagingTok, "content_get", { collection: "posts", id: SLUG }, 1);
  if (src.item.status !== "published") {
    console.warn("Warning: staging item is not published:", src.item.status);
  }

  const { data } = src.item;
  const primaryBylineId = src.item.primaryBylineId;
  const featured = data.featured_image;

  let featuredPayload = featured;
  if (featured?.id) {
    const media = await mcpTool(STAGING_MCP, stagingTok, "media_get", { id: featured.id }, 2);
    const storageKey = media.item?.storageKey || featured.meta?.storageKey;
    if (!storageKey) {
      throw new Error("Cannot resolve staging media storageKey: " + JSON.stringify(media).slice(0, 200));
    }
    const fileUrl = `${STAGING_ORIGIN}/_emdash/api/media/file/${encodeURIComponent(storageKey)}`;
    const imgRes = await fetch(fileUrl, { headers: { Authorization: `Bearer ${stagingTok}` } });
    if (!imgRes.ok) throw new Error(`Download featured image failed ${imgRes.status} ${fileUrl}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ext = path.extname(featured.filename || ".png") || ".png";
    const tmpFile = path.join(REPO_ROOT, "tmp", `promote-featured-${SLUG}${ext}`);
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, buf);

    const alt = featured.alt || featured.filename || "Featured image";
    const up = spawnSync(
      "npx",
      ["emdash", "media", "upload", tmpFile, "--alt", alt, "-u", "https://freedomtimes.news", "-t", prodTok, "--json"],
      { cwd: WEB, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, shell: true },
    );
    if (up.error) throw up.error;
    if (up.status !== 0) {
      throw new Error(
        `media upload exit ${up.status}: ${up.stderr || ""} ${up.stdout || ""}`.trim(),
      );
    }
    const out = up.stdout;
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("media upload: no JSON in output: " + out.slice(0, 500));
    const uploaded = JSON.parse(out.slice(start, end + 1));
    const id = uploaded.id || uploaded.item?.id || uploaded.data?.item?.id;
    if (!id) throw new Error("media upload: no id in " + up.stdout);
    const prodMedia = await mcpTool(PRODUCTION_MCP, prodTok, "media_get", { id }, 3);
    const pm = prodMedia.item || {};
    const metaBase = pm.meta && typeof pm.meta === "object" ? { ...pm.meta } : {};
    const sk = pm.storageKey;
    if (typeof sk === "string" && sk.trim().length > 0) {
      metaBase.storageKey = sk.trim();
    }
    const metaFromProd = Object.keys(metaBase).length > 0 ? metaBase : null;
    featuredPayload = {
      id,
      provider: pm.provider || uploaded.provider || featured.provider || "local",
      filename: pm.filename || uploaded.filename || featured.filename,
      mimeType: pm.mimeType || uploaded.mimeType || featured.mimeType,
      width: pm.width ?? uploaded.width ?? featured.width,
      height: pm.height ?? uploaded.height ?? featured.height,
      alt: pm.alt ?? uploaded.alt ?? alt,
      meta: metaFromProd || uploaded.meta || {},
    };
  }

  const payloadData = {
    title: data.title,
    content: data.content,
    excerpt: data.excerpt,
    subjects: data.subjects,
    featured_image: featuredPayload,
  };

  const destRes = await mcpToolAllowError(PRODUCTION_MCP, prodTok, "content_get", { collection: "posts", id: SLUG }, 10);
  const dest = destRes.ok ? destRes.value : null;

  const bylineArg = primaryBylineId ? { primaryBylineId } : {};

  if (dest?.item) {
    const updated = await mcpTool(PRODUCTION_MCP, prodTok, "content_update", {
      collection: "posts",
      id: SLUG,
      data: payloadData,
      ...bylineArg,
    }, 11);
    console.log("content_update", updated.item?.slug, updated.item?.draftRevisionId);
  } else {
    const created = await mcpTool(PRODUCTION_MCP, prodTok, "content_create", {
      collection: "posts",
      slug: SLUG,
      data: payloadData,
      status: "draft",
      ...bylineArg,
    }, 12);
    console.log("content_create", created.item?.slug, created.item?.id);
  }

  const published = await mcpTool(PRODUCTION_MCP, prodTok, "content_publish", { collection: "posts", id: SLUG }, 13);
  console.log("content_publish", published.item?.status, published.item?.slug);

  if (primaryBylineId) {
    console.log("Note: primaryBylineId was passed:", primaryBylineId, "— verify in production admin if byline resolves.");
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
