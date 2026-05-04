# Plan: EmDash content formats, Portable Text default, and MCP (session handoff)

Use this document at the start of a **new** agent or chat session so work continues without re-explaining the whole thread.

---

## Prompt you can paste into a new session

Read `web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md` and treat it as the source of truth for goals and context. Continue from the **Next steps** section: align `posts` (and optionally `pages`) on **Portable Text** end-to-end, fix or document **MCP** issues around EmDash tokens and content shape, and keep **other collections** able to use HTML or non-PT fields where we explicitly choose that. **When inspecting `posts.content` shape, prefer MCP `content_get` over `npx emdash content get --json`** (see **CLI vs MCP** below)—the CLI answer alone is misleading for PT-backed posts. Before bulk migrations, run the **canary** in `web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`. Match existing code style; do not widen scope beyond EmDash content/MCP unless asked.

---

## Objective

1. **Single coherent body format for editorial posts** — Prefer **Portable Text (PT)** as the stored and rendered default for **`posts`** (and likely **`pages`**), with the **TipTap / rich-text** model EmDash describes, instead of long-lived **markdown strings** mixed with PT.
2. **Predictable APIs and automations** — Anything that reads or writes `data.content` (site, scripts, **MCP tools**) should see **one** expected shape per collection after migration, so we stop debugging “works in admin but breaks on site” or “CLI wrote X but `content get` returns Y.”
3. **Collection-specific rules** — **Posts** (and pages) standardize on PT; **other collections** may keep **HTML** or other field types where the product needs it—implemented as **explicit** schema fields and renderer branches, not accidental mixing on `posts.content`.

---

## Why this exists (problem statement)

After roughly **a week of real EmDash use**, content issues cluster around **format fragmentation**, not random CMS bugs:

| Symptom | Likely root |
|--------|-------------|
| Same article behaves differently in preview vs published, or after a tool edit | **`data.content` sometimes a string, sometimes a PT array** — `resolveEntryBody` and renderers branch on that. |
| Seed says `portableText` but **`npx emdash content get --json`** shows a long **string** | Often **CLI JSON serialization** (markdown in the export), **not** proof the DB lacks PT—confirm with **MCP `content_get`** (`item.data.content` as array), **Turso** (`json_type(content)`), or the **site** renderer. True drift or string writers are still possible; use those checks to tell which. |
| Sent a PT **array** via update; API still returns **string** | **Server-side coercion** or field still typed as plain text in the **running** instance — fix in **EmDash admin / migration**, not only in Astro. |
| Double encoding, lost Unicode, broken promotion | Documented in **`web/CONTENT_PROMOTION_RUNBOOK.md`** — promotion and tooling must stay **UTF-8-safe** and schema-aligned between staging and production. |

The codebase intentionally supports **both** shapes during transition (`web/src/lib/content/entryBody.ts`, legacy path in `contentBlocks.ts` + `EntryBody.astro`). That is **stability**, not the end state. The end state is **PT in storage** for posts (once live schema and all writers agree).

---

## MCP server problems (context for the new session)

Work has touched **Cursor MCP** wiring for EmDash (repo files such as **`.cursor/mcp.json`**, **`.vscode/mcp.json`**, and **`scripts/set-emdash-mcp-tokens.ps1`**). Typical failure modes to verify in a fresh session:

- **Auth** — `EMDASH_STAGING_PAT` / `EMDASH_PRODUCTION_PAT` (or login-derived tokens) missing, expired, or pointing at the wrong base URL. Login tokens expire; PATs are preferred for anything long-lived.
- **URL mismatch** — MCP server `url` must match the instance the token was issued for (staging vs production).
- **Shape mismatch** — **`content_get` over MCP** should return **Portable Text arrays** for `portableText` fields when storage is PT. **`npx emdash content get --json`** may still show a **markdown string** for the same row—**do not treat that as MCP being wrong**; treat it as **CLI presentation**. Writes must still send **PT arrays** (or the API-supported shape) so editors and storage stay aligned.
- **Tool/schema drift** — After **`emdash`** package bumps (`web/package.json`), confirm MCP still targets a compatible API; re-read tool descriptors if the MCP host caches them.

The new session should **reproduce** MCP failures with a minimal call (e.g. get one known slug), compare to **`npx emdash content get`** from `web/`, and fix **tokens, URLs, or payload shape** before changing app code.

---

## CLI vs MCP: which tool to use for `content` (important)

**Problem:** Agents often default to **`npx emdash content get … --json`** because it is familiar and scriptable. For **`portableText`** fields on **`posts` / `pages`**, that routinely produces **`data.content` as a markdown string** in JSON even when **Turso stores a PT array** and **MCP returns PT**. Relying on the CLI alone has caused **wrong conclusions**, **repeated canaries**, and **wasted time and tokens** chasing “legacy string storage” that is not what the database holds.

**Default for shape / automation truth:** use **staging or production MCP** (`content_get`, and `content_update` when editing) with a valid bearer token. The MCP response wraps the entry as **`item`** (use **`item.data.content`**). Observed on staging (2026-05-04): same published post showed **`STR`** via CLI JSON and **`PT blocks 66`** via MCP—aligned with Turso `json_array_length(content)`.

**When the CLI is still appropriate:** quick human checks, CI that only needs title/slug/status, or flows that intentionally consume markdown. Do **not** use CLI-only JSON to decide whether Portable Text exists in storage.

**HTTP MCP notes (non-IDE callers):** `POST /_emdash/api/mcp` expects header **`Accept: application/json, text/event-stream`**. Stale **`EMDASH_*_PAT`** env values may return `INVALID_TOKEN`; **`~/.config/emdash/auth.json`** access tokens from `emdash login` often work for the same host.

**Release context:** EmDash **0.8.x–0.9.x** expanded MCP surface (`settings_*`, richer `content_update`, structured errors, etc.); see [emdash@0.8.0](https://github.com/emdash-cms/emdash/releases/tag/emdash%400.8.0) and [emdash@0.9.0](https://github.com/emdash-cms/emdash/releases/tag/emdash%400.9.0). None of those notes promise that **`content get --json`** returns raw PT arrays for rich-text fields.

---

## What is already in the repo (do not redo blindly)

- **`web/.emdash/seed.json`** — `posts.content` and `pages.content` are defined as **`portableText`** (intended contract).
- **`web/src/lib/content/entryBody.ts`** — `resolveEntryBody`: non-empty array → PT; non-empty string → legacy markdown; empty otherwise.
- **`web/src/lib/content/contentEntry.ts`** — `buildContentEntryViewModel` uses `resolveEntryBody` for `data.content`.
- **`web/src/lib/content/contentBlocks.ts`** — `parseLegacyTextContent`, `buildPortableRenderNodes` (translate `<details class="translate">` pattern in PT).
- **`web/src/components/EmDashContentView.astro`** — Wires PT components (`PortableLink`, `Video.astro`, `Audio.astro`) and legacy blocks.
- **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** — Dependency bump checks + **canary** to classify `data.content` as PT vs string.
- **`web/CONTENT_PROMOTION_RUNBOOK.md`** — Staging → production promotion, schema parity, UTF-8 notes.
- **EmDash versions** — `web/package.json`: **`emdash`** and **`@emdash-cms/cloudflare`** on **`^0.9.0`**. As of **2026-05-04**, npm **`latest`** for both packages is still **0.9.0** (`npm install …@latest` does not advance further). **`emdash@1.0.0`** exists on the registry but is **deprecated** (“Please install the latest version”), and **`@emdash-cms/cloudflare@0.9.0`** declares a **pinned** dependency **`emdash@0.9.0`**, so the Worker integration cannot move to 1.x until a new adapter release ships. The CLI banner may show **`v0.0.0`** even when the installed package is **0.9.0** (cosmetic upstream issue).

---

## Next steps (ordered for a new session)

### Plan progress (where we are — staging flagship post)

| Step | Status |
|------|--------|
| **1. Live schema** (`posts.content` = Portable Text) | **Done** — Admin UI + `npx emdash schema get posts` on staging show **`portableText`**. |
| **2. Canary / truth on shape** | **Done for this article** — Turso: **`json_type(content)=array`**, **66** blocks. MCP **`content_get`**: **`PT blocks 66`**. CLI **`content get --json`** still shows **`STR`** (known serialization; do not use alone). |
| **3. Writers / promotion** | **Done for scripted promote** — `web/scripts/promote-post-staging-to-production.mjs` loads staging **`data` via HTTP MCP `content_get` by default** (`PROMOTE_STAGING_SOURCE=auto`: MCP, then CLI on failure; `cli` / `mcp` to force). **`data.content` is rejected from MCP when not array-shaped** unless `auto` falls back to CLI (**SEVERE WARNING** banner on stderr). Production create/update still use the CLI with a JSON **`--file`** built from that `data`. |
| **4. Bulk migration** | **Out of scope for now** — New and migrated editorial **`posts`** are expected as **Portable Text** via MCP / promote path; **no bulk string→PT migration** planned until (if ever) Turso shows legacy string bodies worth converting. |
| **5. Per-collection HTML** | Not started (only if product needs raw HTML fields). |
| **6. MCP hardening** | **Partial** — Docs + `Accept` header for HTTP MCP; PAT vs `auth.json` noted. Cursor MCP STATUS may still show errors until tokens/IDE are aligned. |

**`web/.tmp/ines-chatin-staging-create.json`** already defines **`data.content` as a PT block array** (not a markdown string), consistent with what is in Turso for slug **`ines-chatin-liberation-investigation-france-context`**.

### Remaining work (execute in order)

1. **Production parity** — Confirm **`posts.content`** field type in **`/_emdash/admin`** on **production** and run **`node web/scripts/canary-emdash-content-shape.mjs https://freedomtimes.news posts <slug> --mcp`** (and/or Turso `json_type`) on representative slugs **before** large promotions.
2. **Promote / ship** — Use **`node web/scripts/promote-post-staging-to-production.mjs`** (MCP staging snapshot by default) for flagship **`posts`** after production bylines/media prerequisites; re-verify live page + MCP readback.
3. **Bulk migration** — **Skip** unless you later find **production** posts whose **`content`** is genuinely a **string** in Turso; then treat as a separate project with **`content update`** + rollback discipline (**`web/CONTENT_PROMOTION_RUNBOOK.md`**).
4. **MCP hardening** — Keep **`scripts/set-emdash-mcp-tokens.ps1`** / IDE MCP URLs aligned with **`emdash login`** hosts; after **`emdash`** bumps, smoke **`content_get`** (IDE or **`canary … --mcp`**) and a no-op or test promote path if you add one.
5. **Per-collection HTML** — Defer until product needs a non-PT body field on a non-`posts` collection; keep **`posts.content`** on PT.

### Canary log (append as you run checks)

- **2026-05-04 (CLI, UTF-8 via Node `execSync` / new script)** — Staging published `posts/ines-chatin-liberation-investigation-france-context`: **`STR`** (markdown-length string). Production published `posts/breton-mayor-treogan-investigation-review`: **`STR`**. Same slug on production was **not found** (article not promoted yet). **Note:** PowerShell `Out-File` on piped `npx emdash --json` can mojibake Unicode; use **`node web/scripts/canary-emdash-content-shape.mjs`** or capture JSON from Node.
- **2026-05-04 (Turso read-only SQL, staging `freedomtimes-emdash-staging`)** — For `posts/ines-chatin-liberation-investigation-france-context`, **`ec_posts.content`** has **`json_type(content) = array`** and **`json_array_length(content) = 66`**: **Portable Text is stored in the database**. Admin + `schema get` already show **`portableText`**. The **`STR`** canary from **`content get --json`** is therefore **API/CLI presentation** (markdown string in JSON), not “SQLite only has markdown strings.”
- **2026-05-04 (MCP `content_get`, staging)** — Same slug: **`item.data.content` → `PT blocks 66`**, matching Turso. Confirms **MCP + DB agree**; **CLI JSON** is the misleading path for PT shape.

1. **Verify live schema** — ~~In EmDash admin, confirm **`posts.content`** …~~ **Done on staging** (see **Plan progress**). Repeat for **production** before big promotions if unsure.
2. **Canary** — **Staging flagship validated** (Turso + MCP). Still run **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** §2 for **other slugs** and **production** using **MCP or Turso** for PT truth—not CLI JSON alone.
3. **Fix writers first** — Scripted **staging → production** promote now **prefers MCP** for the staging snapshot (see **Plan progress** row 3). Other flows (manual CLI, one-off scripts) should still prefer **MCP** or hand-built JSON with **PT arrays** for `posts.content`.
4. **Bulk migration** — **Not planned** while new content stays MCP-first and PT-backed; revisit only if audits find real **string** storage on important slugs.
5. **Per-collection HTML** — For collections that need raw HTML, use **separate fields** and a small **collection-aware** resolver (see comment in `entryBody.ts` about adapters); do not overload `posts.content` with HTML.
6. **MCP hardening** — Align env vars with `scripts/set-emdash-mcp-tokens.ps1`; document any tool limits in this file or next to MCP config if non-obvious.

---

## Key files quick index

| Area | Path |
|------|------|
| Body resolution | `web/src/lib/content/entryBody.ts` |
| View model | `web/src/lib/content/contentEntry.ts` |
| Legacy + PT processing | `web/src/lib/content/contentBlocks.ts` |
| Article layout | `web/src/components/EmDashContentView.astro`, `web/src/components/content/EntryBody.astro` |
| PT embed: video | `web/src/components/Video.astro` (`_type: "video"`) |
| PT embed: audio / podcasts | `web/src/components/Audio.astro` (`_type: "audio"`) |
| Seed / intended schema | `web/.emdash/seed.json` |
| PR / canary | `web/docs/PR_CHECKLIST_EMDASH_CONTENT.md` |
| Promotion | `web/CONTENT_PROMOTION_RUNBOOK.md` |
| English glosses / global audience | `web/docs/EDITORIAL_ENGLISH_GLOSSES.md` |
| Staging PT patch + publish | `web/scripts/merge-staging-post-from-patch.mjs`, `web/.emdash/article-patches/*.json` |
| MCP token helper | `scripts/set-emdash-mcp-tokens.ps1` |
| HTTP MCP `content_get` | `web/scripts/emdash-mcp-client.mjs` (used by promote + canary `--mcp`) |
| PT shape canary (CLI or MCP) | `web/scripts/canary-emdash-content-shape.mjs` |
| Agent default (PT vs CLI) | `AGENTS.md` (EmDash MCP first) |

---

## Success criteria (short)

- **Canary** shows **`PT blocks N`** for representative published posts after migration and correct admin field type.
- **No silent coercion** — Writing a PT array does not round-trip to a string for those fields.
- **MCP** — Documented, reproducible steps to get/edit post content without format regression.
- **Site** — `/posts/<slug>` matches editor intent for flagship articles (headings, links, translate folds, embeds).

When this plan is stale, update **Next steps** and the **paste prompt** so the next session still lands correctly.
