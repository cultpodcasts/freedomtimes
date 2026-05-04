# Plan: EmDash content formats, Portable Text default, and MCP (session handoff)

Use this document at the start of a **new** agent or chat session so work continues without re-explaining the whole thread.

---

## Prompt you can paste into a new session

Read `web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md` and treat it as the source of truth for goals and context. Continue from the **Next steps** section: align `posts` (and optionally `pages`) on **Portable Text** end-to-end, fix or document **MCP** issues around EmDash tokens and content shape, and keep **other collections** able to use HTML or non-PT fields where we explicitly choose that. Before bulk migrations, run the **canary** in `web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`. Match existing code style; do not widen scope beyond EmDash content/MCP unless asked.

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
| Seed says `portableText` but `content get` shows a long **string** | **Live schema drift** from `web/.emdash/seed.json`, and/or **writers** (CLI, imports, MCP) sending **markdown strings**. |
| Sent a PT **array** via update; API still returns **string** | **Server-side coercion** or field still typed as plain text in the **running** instance — fix in **EmDash admin / migration**, not only in Astro. |
| Double encoding, lost Unicode, broken promotion | Documented in **`web/CONTENT_PROMOTION_RUNBOOK.md`** — promotion and tooling must stay **UTF-8-safe** and schema-aligned between staging and production. |

The codebase intentionally supports **both** shapes during transition (`web/src/lib/content/entryBody.ts`, legacy path in `contentBlocks.ts` + `EntryBody.astro`). That is **stability**, not the end state. The end state is **PT in storage** for posts (once live schema and all writers agree).

---

## MCP server problems (context for the new session)

Work has touched **Cursor MCP** wiring for EmDash (repo files such as **`.cursor/mcp.json`**, **`.vscode/mcp.json`**, and **`scripts/set-emdash-mcp-tokens.ps1`**). Typical failure modes to verify in a fresh session:

- **Auth** — `EMDASH_STAGING_PAT` / `EMDASH_PRODUCTION_PAT` (or login-derived tokens) missing, expired, or pointing at the wrong base URL. Login tokens expire; PATs are preferred for anything long-lived.
- **URL mismatch** — MCP server `url` must match the instance the token was issued for (staging vs production).
- **Shape mismatch** — If MCP tools read/write **`content`** as a **string** while the field is **Portable Text** in admin, tools can **reintroduce** legacy strings or confuse operators. Any MCP content helpers should match the **same** contract as the CLI and the site (`array` vs `string` per environment).
- **Tool/schema drift** — After **`emdash`** package bumps (`web/package.json`), confirm MCP still targets a compatible API; re-read tool descriptors if the MCP host caches them.

The new session should **reproduce** MCP failures with a minimal call (e.g. get one known slug), compare to **`npx emdash content get`** from `web/`, and fix **tokens, URLs, or payload shape** before changing app code.

---

## What is already in the repo (do not redo blindly)

- **`web/.emdash/seed.json`** — `posts.content` and `pages.content` are defined as **`portableText`** (intended contract).
- **`web/src/lib/content/entryBody.ts`** — `resolveEntryBody`: non-empty array → PT; non-empty string → legacy markdown; empty otherwise.
- **`web/src/lib/content/contentEntry.ts`** — `buildContentEntryViewModel` uses `resolveEntryBody` for `data.content`.
- **`web/src/lib/content/contentBlocks.ts`** — `parseLegacyTextContent`, `buildPortableRenderNodes` (translate `<details class="translate">` pattern in PT).
- **`web/src/components/EmDashContentView.astro`** — Wires PT components (`PortableLink`, `PortableVideo`) and legacy blocks.
- **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** — Dependency bump checks + **canary** to classify `data.content` as PT vs string.
- **`web/CONTENT_PROMOTION_RUNBOOK.md`** — Staging → production promotion, schema parity, UTF-8 notes.
- **EmDash versions** — `web/package.json`: **`emdash`** and **`@emdash-cms/cloudflare`** on **`^0.9.0`** (verify lockfile after `npm install`).

---

## Next steps (ordered for a new session)

### Canary log (append as you run checks)

- **2026-05-04 (CLI, UTF-8 via Node `execSync` / new script)** — Staging published `posts/ines-chatin-liberation-investigation-france-context`: **`STR`** (markdown-length string). Production published `posts/breton-mayor-treogan-investigation-review`: **`STR`**. Same slug on production was **not found** (article not promoted yet). **Note:** PowerShell `Out-File` on piped `npx emdash --json` can mojibake Unicode; use **`node web/scripts/canary-emdash-content-shape.mjs`** or capture JSON from Node.
- Conclusion so far: API still returns **string** bodies for sampled posts even though **`web/.emdash/seed.json`** declares **`portableText`** — treat as **legacy rows and/or serializer** until admin field type + re-save or migration proves **`PT blocks N`**.

1. **Verify live schema** — In EmDash admin, confirm **`posts.content`** (and **`pages.content`**) is actually **Portable Text**, not plain text. Compare to **`web/.emdash/seed.json`**.
2. **Canary** — Run §2 of **`web/docs/PR_CHECKLIST_EMDASH_CONTENT.md`** on staging (then production when ready). Record a few slugs as **`PT blocks N`** vs **`STR chars M`**.
3. **Fix writers first** — Ensure CLI, scripts, and **MCP** paths that touch posts send **PT arrays** when the field is PT, or document a temporary “markdown-only” pipeline until migration completes.
4. **Bulk migration (optional, when schema is PT)** — Convert legacy **string** bodies to PT (reuse or extend patterns in **`parseLegacyTextContent`** / any existing one-off converters), **`content update`** with correct **`--rev`**, then re-canary. Pilot on a small slug set; keep Turso rollback / promotion discipline per runbook for production.
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
| Seed / intended schema | `web/.emdash/seed.json` |
| PR / canary | `web/docs/PR_CHECKLIST_EMDASH_CONTENT.md` |
| Promotion | `web/CONTENT_PROMOTION_RUNBOOK.md` |
| MCP token helper | `scripts/set-emdash-mcp-tokens.ps1` |

---

## Success criteria (short)

- **Canary** shows **`PT blocks N`** for representative published posts after migration and correct admin field type.
- **No silent coercion** — Writing a PT array does not round-trip to a string for those fields.
- **MCP** — Documented, reproducible steps to get/edit post content without format regression.
- **Site** — `/posts/<slug>` matches editor intent for flagship articles (headings, links, translate folds, embeds).

When this plan is stale, update **Next steps** and the **paste prompt** so the next session still lands correctly.
