# EmDash Content Promotion Runbook (Staging -> Production)

This runbook documents the repeatable process for getting verified staging content live on production.

## Scope

- Promote entries (for example `posts`, `pages`, `archives`) from staging to production.
- Verify items are truly published (not draft-only).
- Recover from admin "Collection not found" when schema/metadata drifted between environments (not legacy manifest cache — see §5).
- For `archives`, validate associated media assets are present in production before go-live.
- Prevent content corruption during promotion by using UTF-8-safe transfer and explicit staging-versus-production content checks.

## Staging Policy

- Staging is publish-only for `posts` and `pages` (no drafts workflow).
- Local staging rebuild enforces `supports` as `["revisions","search"]` for `posts` and `pages` via `web/scripts/enforce-publish-only-collections.cjs` (see `scripts/Invoke-EnvironmentRebuild.ps1`).

## Prerequisites

1. Node dependencies installed in `web/` (`npm install`).
2. EmDash API token for staging and production.
3. Collection schema parity between staging and production.
4. A Turso rollback branch has been created for production before any migration or production content promotion.
5. The promotion path being used is scripted and UTF-8-safe. Do not use manual copy/paste or ad hoc terminal redirection for content payloads.

## Turso backups before any mutating work

### Turso CLI in WSL

**Primary reference:** **[docs/CLI_PATHS_WINDOWS.md](../docs/CLI_PATHS_WINDOWS.md)** — Turso is WSL-only in this workspace; auth, PATH quirks, verification, and invoke patterns live there.

From **PowerShell** at repo root:

```powershell
wsl bash -lic "turso db list"
# or: wsl bash -lc '$HOME/.turso/turso db list'
```

Rollback-branch helper from WSL: `./scripts/turso-create-rollback-branch-wsl.sh`.

**Rule:** create a **recoverable backup** of the **specific Turso database** you are about to change **before** migrations, seeds, manual SQL, content promotion, or bulk CMS updates. Do not skip this for small or “obvious” edits.

**Option A — file export (any Turso DB you can access with the CLI)**  
After `turso auth login` in **WSL** (see [Turso CLI introduction](https://docs.turso.tech/cli/introduction)). From repo root in PowerShell:

```powershell
wsl bash -lc 'export PATH="$HOME/.turso:$PATH"; mkdir -p .release/backups; turso db export freedomtimes-emdash-staging --output-file ./.release/backups/emdash-staging-$(date +%Y%m%d-%H%M%S).db'
```

Or inside an interactive WSL shell:

```bash
export PATH="$HOME/.turso:$PATH"
turso db export freedomtimes-emdash-staging --output-file ./.release/backups/emdash-staging-$(date +%Y%m%d-%H%M%S).db
```

Use the real database name from `turso db list` (for example `freedomtimes-emdash-staging`, `freedomtimes-scheduler-staging`). Keep the file until the change is verified. Add `--overwrite` only when re-running the same command intentionally.

**Option B — production rollback branch (EmDash production before risky work)**  
Use `scripts/turso-create-rollback-branch.ps1` with `-AllowProduction` as already required in the prerequisites below; keep the emitted JSON under `.release/rollback-branches/`.

Agents and operators should treat **scheduler** and **subscriptions** databases the same way whenever `web/scripts/apply-turso-sql.ts` or direct SQL is used against them.

For **PR review** (EmDash version bumps, `content` / Portable Text refactors), use **`docs/PR_CHECKLIST_EMDASH_CONTENT.md`** — includes a **canary `content get`** to verify whether `data.content` is PT (`array`) or a legacy string.

For **English copy** that cites French media or institutions (glosses on *France Inter*, *France Info*, hoisting stakes in the lede), use **`web/docs/EDITORIAL_ENGLISH_GLOSSES.md`** — including the **canonical Portable Text pattern** for a **French `blockquote` + English `<details>`** translation fold (same section).

Set local env vars before running commands:

```powershell
$env:EMDASH_STAGING_URL = "https://staging.freedomtimes.news"
$env:EMDASH_PRODUCTION_URL = "https://freedomtimes.news"
$env:EMDASH_STAGING_TOKEN = "<staging-token>"
$env:EMDASH_PRODUCTION_TOKEN = "<production-token>"
```

## 1. Step 1: Prove Production Matches Staging Before Content Promotion

Schema changes are made on staging during development. By release time, staging schema should already be valid.

Step 1 is not just a field check. Step 1 is to prove that production matches staging in schema semantics and runtime visibility before promoting any content.

What must be true before content promotion begins:

1. The collection exists in production.
2. Field definitions match staging.
3. Collection-level metadata and behavior match staging, especially `source`, `supports`, labels, and other collection settings that affect runtime/editor behavior.
4. The collection appears in the production manifest.
5. The production admin collection route resolves.

If any of those fail, stop. Fix schema or manifest state first. Content promotion is not the step that should reveal schema drift.

This step also requires that a production rollback branch already exists. Never start migration into production without taking that checkpoint first.

Release rule: if a PR contains code or content promotion that depends on EmDash schema, do not close the PR and do not allow the `main` deployment until this parity check passes or the missing schema has been applied to production.

From the **repo root**, verify the collection exists and inspect it in both environments using **EmDash MCP** (not `npx emdash schema …` — see **`AGENTS.md`**). `cd web` first; token comes from `~/.config/emdash/auth.json` or `EMDASH_*_TOKEN` env vars.

```powershell
cd web
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_STAGING_URL schema_list_collections '{}'
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_PRODUCTION_URL schema_list_collections '{}'

node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_STAGING_URL schema_get_collection '{"slug":"archives"}'
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_PRODUCTION_URL schema_get_collection '{"slug":"archives"}'
```

Do not promote content until collection fields and collection metadata match.

Then verify runtime visibility in production:

1. `/_emdash/api/manifest` contains the collection.
2. `/_emdash/admin/content/<collection>` resolves.
3. If schema appears correct but the collection is missing from `/_emdash/api/manifest` or the admin route fails, compare `_emdash_collections` metadata (`supports`, `source`, labels) between staging and production before promoting content (see §5). EmDash **0.9+** builds the admin manifest from the live database on each request — there is no `emdash:manifest_cache` row to clear on current releases (`emdash@0.27.x`).

## 2. Confirm Staging Item Is Actually Published

Listing published entries is not enough when draft/live pointers were previously inconsistent.
Check both draft view and published view for each item:

```powershell
cd web
# Example: post slug "example-post" — MCP content_get (raw JSON / PT-safe)
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_STAGING_URL content_get '{"collection":"posts","id":"example-post"}'
```

Expected outcome:

- `item.status` is `published` when the live version is published.
- Inspect `item.data` (including `data.content` as an array when storage is Portable Text).

If needed, publish explicitly via MCP:

```powershell
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_STAGING_URL content_publish '{"collection":"posts","id":"example-post"}'
```

## 3. Promote Content to Production

Recommended operational pattern:

1. Read source item from staging via **MCP `content_get`** (or the promote script below).
2. Create or update the same slug in production via **MCP** (or the promote script — it uses `content_create` / `content_update` / `content_publish`).
3. Do **not** use `npx emdash content …` for these steps when you need the real stored JSON (**`AGENTS.md`**).

Hard rule:

- Do not manually copy JSON between terminals, editors, clipboards, or shell redirection steps when promoting content.
- Use a scripted UTF-8-safe path only (promote script writes `.tmp` artifacts as UTF-8).
- If the promotion path cannot prove UTF-8 preservation, do not use it for production.

Manual MCP verification (optional):

```powershell
cd web
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_STAGING_URL content_get '{"collection":"posts","id":"example-post"}'
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_PRODUCTION_URL content_get '{"collection":"posts","id":"example-post"}'
```

Notes:

- `archives` usually include media references; ensure required files exist in production media storage.
- For updates, MCP `content_update` requires `_rev` from `content_get` (or REST `GET /_emdash/api/content/...`); the scripted promoter handles this.

### Featured media and bylines (posts)

Staging media IDs and R2 keys do **not** exist in production. Promoting only the `data` JSON without fixing `featured_image` leaves production pointing at missing media (broken hero images).

Bylines are **not** set by copying `primaryBylineId` in a raw JSON file: the API expects a `bylines` array on create/update (see EmDash `contentUpdateBody`). Use `bylines: [{ "bylineId": "<id>" }]` in a follow-up `PUT` to `/_emdash/api/content/<collection>/<slug>`, or use the scripted promoter below.

**Scripted path (recommended for `posts`):** from repo root, after `emdash login` for both URLs:

```powershell
node web/scripts/promote-post-staging-to-production.mjs posts <slug>
```

This script:

1. Loads staging **`data` via MCP `content_get` only** (keeps **Portable Text** arrays in `data.content`). There is **no** CLI fallback.
2. Writes production with **MCP** `content_create` / `content_update` / `content_publish` (not `npx emdash content …`).
3. If `data.featured_image` references a media id that does not exist in production, downloads the file from the **public** staging URL `/_emdash/api/media/file/<storageKey>`, uploads it to production, and rewrites `featured_image` before create/update.
4. If staging has `primaryBylineId`, applies **`content_update`** with `bylines: [{ bylineId }]`, then **`content_publish`**.

Ensure the byline id already exists in production (for example list `GET /_emdash/api/admin/bylines` with a bearer token). If the guest author only exists on staging, create the matching byline in production first.

Required content-integrity rule:

- Before publishing production content, compare the staged source fields with the production fields that matter for rendering.
- At minimum compare `title`, `abstract`, `excerpt`, `description`, and any other text fields rendered on the public route.
- Fail the promotion if production text differs from staging text unexpectedly.
- Treat mojibake signatures such as `ΓÇ`, `â€™`, `â€œ`, `â€`, or `╬ô├ç├û` as a hard stop.

Minimum integrity verification after create/update and before sign-off:

```powershell
cd web
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_STAGING_URL content_get '{"collection":"posts","id":"example-post"}' | Out-File -Encoding utf8 ..\.tmp\integrity-staging.json
node scripts/emdash-mcp-tools-call.mjs --url $env:EMDASH_PRODUCTION_URL content_get '{"collection":"posts","id":"example-post"}' | Out-File -Encoding utf8 ..\.tmp\integrity-production.json
```

If production text is corrupted and staging is clean, use the guarded repair helper instead of manual edits:

```powershell
.\scripts\repair-production-content-from-staging.ps1 -Collection archives -Ids 2024-07-14-freedom-times -FieldNames abstract -RollbackMetadataFile .\.release\rollback-branches\<timestamp>-<rollback-db>.json -AllowProduction
```

## 4. Archives Media/R2 Preflight (Required for Archives Releases)

If promoting `archives`, run this preflight before final publish checks:

```powershell
# Compare staging vs production media inventory (high-level)
npx --prefix web emdash media list -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash media list -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Inspect specific media record referenced by archive content
npx --prefix web emdash media get <media-id> -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Upload missing media into production
npx --prefix web emdash media upload .\path\to\asset.png --alt "Archive asset" -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

Operational rule:

- Do not mark an archives release complete until all referenced media records resolve in production and the corresponding archive pages render with working image/file links.
- Do not mark an archives release complete until rendered archive text also matches staging for the promoted fields and contains no mojibake.

## 5. Recover From "Collection not found" Admin Issues

Symptom:

- Admin route shows `Collection "archives" not found` (or similar).
- Row exists in `_emdash_collections`, but metadata differs from staging or the manifest API omits the collection.

**EmDash 0.9+ (including `emdash@0.27.x`):** the admin manifest is built fresh from `_emdash_collections` on each admin request. There is **no** runtime `emdash:manifest_cache` options row to invalidate. Deleting a legacy `emdash:manifest_cache` row (if one survived an old upgrade) is harmless but usually unnecessary.

Recovery (for the target environment database):

1. Compare staging vs production `_emdash_collections` for the slug: `supports`, `source`, labels, and related field rows.
2. Fix metadata drift (schema promotion script, MCP `schema_*`, or targeted SQL on the rollback branch) — do not promote content until parity matches staging semantics.
3. Reload `/_emdash/api/manifest` and `/_emdash/admin/content/<collection>`.

Optional legacy cleanup (only if you confirm a pre-0.9 row still exists and want to shrink `options`):

```sql
delete from options where name = 'emdash:manifest_cache';
```

After metadata is aligned, reload admin and re-test the collection route.

## 6. Production Go-Live Checklist

1. Schema parity confirmed (`schema list/get`).
2. Staging source item validated as published.
3. Production item created/updated and published.
4. Production `--published` read returns expected content.
5. Public route renders expected page.
6. For archives, media links and downloadable file URLs work.
7. Staging-versus-production text-bearing fields were compared for the promoted items.
8. No mojibake signatures appear in production content or on the rendered public route.
