# PR checklist: EmDash upgrades & entry body (`content`)

Use this list when a PR bumps **`emdash`** / **`@emdash-cms/cloudflare`**, or changes **`web/src/lib/content/`** (`contentEntry.ts`, `entryBody.ts`, `contentBlocks.ts`), **`EmDashContentView`**, or publish scripts that write `posts.data.content`.

---

## 1. Local (before merge)

- [ ] **`cd web && npm install`** — lockfile matches `package.json`.
- [ ] **`npm run build`** — requires env from your secrets (at minimum **`TURSO_DATABASE_URL`** per `astro.config.ts`; add others your CI uses).
- [ ] If you rely on IDE diagnostics only on touched files, skim **`entryBody`** / **`contentEntry`** for import cycles or unused exports.

Optional full-repo typecheck (currently noisy elsewhere):

- [ ] **`npx tsc --noEmit`** — only gate the PR on this if you have fixed or excluded known issues in `capacitor.config.ts` / `service-worker.ts`.

---

## 2. Canary: what shape is `data.content`? (staging / production)

### 2.0 Does the `posts` collection need a schema change for Portable Text?

**In this repo’s seed, it is already Portable Text.** `web/.emdash/seed.json` defines `posts.fields` with `"slug": "content", "type": "portableText"` (same for `pages.content`). That is the **intended** EmDash contract: TipTap in admin, PT JSON in storage.

You only need a **schema change** if the **live** instance (staging/production) disagrees—for example the admin UI still shows `content` as plain **text / markdown**, or `content get` keeps returning a **string** (`STR` in the canary below) after you publish from the rich editor. Then either:

- the database was created or migrated from an older definition (field was **text**), or  
- a writer path (CLI, MCP, import) is **coercing** arrays to strings even though the column supports JSON.

**Action:** In **`/_emdash/admin`**, open the **Posts** content type and confirm **`content`** is the **rich text / Portable Text** field type, matching `seed.json`. If it is plain text, change it per **EmDash docs** for altering field types (expect a migration / re-save story for existing entries). After that, re-run the canary: you want **`PT blocks N`** for new or re-saved posts.

**`resolveEntryBody`** in `entryBody.ts` already supports both shapes until storage is fully aligned.

---

### 2.0a Prefer MCP over CLI when asking “is this post Portable Text?”

**Why:** `npx emdash content get … --json` often shows **`data.content` as a long markdown string** (`STR` in the classifier below) even when the **database stores a PT array** and **MCP `content_get`** returns **`item.data.content`** as **`PT blocks N`**. Defaulting to the CLI for investigations has wasted time and tokens re-litigating “legacy string storage.”

**Do this instead (staging/production):**

1. Use Cursor’s **EmDash MCP** server (or `POST /_emdash/api/mcp` with JSON-RPC `tools/call` / `content_get`) with a valid bearer token.
2. Parse the tool result’s **`item`** object; inspect **`item.data.content`**. If it is an **array**, the CMS body is **Portable Text** for that read path.
3. Use **CLI `content get`** when you only need slugs/metadata, or when you explicitly want the markdown export—**not** as the single source of truth for whether PT exists in storage.

**HTTP callers:** send **`Accept: application/json, text/event-stream`** on MCP POSTs. See `web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md` section **CLI vs MCP**.

**CLI-side MCP canary:** `node web/scripts/canary-emdash-content-shape.mjs <baseUrl> posts <slug> --mcp` (uses `~/.config/emdash/auth.json` for that host). Prefer **`… (MCP)`** in the output for PT truth; the default CLI path appends **`(CLI)`** and may show **`STR`** for rich text even when storage is PT.

---

EmDash can still **return** `content` as a string to **some** clients (notably **CLI JSON**) while other paths return PT. The **public site** and **`resolveEntryBody`** depend on what the **Worker read path** supplies—validate with MCP/Turso when in doubt.

### 2a. Save one published post JSON

Pick a **stable slug** (e.g. a flagship article) or a **throwaway canary post** created for this check.

**Staging:**

```powershell
cd web
$env:EMDASH_STAGING_URL = "https://staging.freedomtimes.news"
# Token: env var or ~/.config/emdash/auth.json from `npx emdash login -u $env:EMDASH_STAGING_URL`

npx emdash content get posts YOUR_SLUG --published -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json |
  Out-File -Encoding utf8 ..\.tmp\canary-post-staging.json
```

**Production** (same, swap URL and token):

```powershell
$env:EMDASH_PRODUCTION_URL = "https://freedomtimes.news"
npx emdash content get posts YOUR_SLUG --published -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json |
  Out-File -Encoding utf8 ..\.tmp\canary-post-production.json
```

### 2b. Classify `content` (Node one-liner)

From **repo root** (paths match files written above):

```powershell
node -e "const fs=require('fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));const c=j.data&&j.data.content;console.log(p, Array.isArray(c)?'PT blocks '+c.length:'STR chars '+(''+c).length);"
```

Pass `.tmp/canary-post-staging.json` and `.tmp/canary-post-production.json`.

**Interpret:**

| Output        | Meaning                                      | Renderer path                          |
|---------------|----------------------------------------------|----------------------------------------|
| `PT blocks N` | Portable Text array stored in CMS          | `portableContent` → `astro-portabletext` |
| `STR chars M` | Legacy string (markdown-ish) body            | `textContent` → legacy parser / `<p>`  |

You want **`PT`** on canary posts once the live **`content`** field is truly **Portable Text** and entries are saved through that type. **`STR` from CLI JSON alone** does **not** prove legacy storage—check **§2.0a (MCP)** or **Turso** before concluding. **`STR`** everywhere (MCP + DB + admin) would indicate legacy rows, plain-text field type, or coercion on write—use §2.0 to decide which.

### 2c. Clear stale env tokens (Windows)

If `content get` returns **401 / invalid token**, clear overrides so the CLI can use **`~/.config/emdash/auth.json`**:

```powershell
Remove-Item Env:EMDASH_STAGING_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:EMDASH_STAGING_PAT -ErrorAction SilentlyContinue
```

---

## 3. Smoke after deploy (staging first)

- [ ] **Homepage** loads and lists posts.
- [ ] **`/posts/<slug>`** for the canary slug: headings, paragraphs, **source links** if markdown legacy.
- [ ] **Translate folds**: if the article uses `<details class="translate">`, confirm summary + body still render (portable and legacy paths both support this pattern).
- [ ] **`/archives/...`** if the PR touched archives or shared content code.

---

## 4. Merge / promotion hygiene

- [ ] **Schema parity**: staging field types match production before promoting content (see `CONTENT_PROMOTION_RUNBOOK.md`).
- [ ] **No silent body coercion**: if you POST a PT array but **`content get`** still shows **`STR`**, fix schema or API path before bulk migration — do not assume the web app alone can fix storage.

---

## 5. Rollback

- [ ] Revert the dependency commit and redeploy **or** roll the Worker / site to the previous release in Cloudflare.
- [ ] Re-run the **canary** in §2 on staging to confirm restored behaviour.
