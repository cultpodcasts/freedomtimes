# Production Release Runbook

This runbook is the single path for promoting all production-facing changes:

- Terraform and infrastructure changes
- EmDash runtime/app updates
- Layout and frontend changes
- EmDash schema changes
- EmDash content changes

## Change Type To Deployment Path

| Change type | Deployment path | Notes |
|---|---|---|
| Layout/UI changes (`web/src/**`) | PR → `deploy-worker.yml` staging job; operator merges → `deploy-worker.yml` production job (backup, then deploy) ([§2a](#2a-standard-github-actions-deploy-workeryml)). Local fallback: [§2b](#2b-local-production-deploy-fallback) | `terraform-production.yml` on push stays plan + EmDash `--check` only. The Worker deploy on merge is `deploy-worker.yml`. CI never syncs Worker secrets. |
| EmDash runtime updates (`web` dependencies/config) | Same as layout/UI: `deploy-worker.yml` ([§2a](#2a-standard-github-actions-deploy-workeryml)), local fallback [§2b](#2b-local-production-deploy-fallback) | Check the staging job and staging site before merging; the merge deploys production. |
| Terraform/IaC changes (`infra/terraform/**`) | `terraform-production.yml` plans on push. Apply with `deploy-production-local.ps1`; a CI apply dispatch is for non-Worker changes only and is refused while the `holding_page` drift exists | Applies managed infrastructure and captures outputs |
| EmDash **core** schema (`emdash migrate` / `.emdash/migrations.json`) | Deploy pipeline: `deploy-worker.yml` ([§2a](#2a-standard-github-actions-deploy-workeryml)) or local `deploy-*-local.ps1` ([§2b](#2b-local-production-deploy-fallback)). Legacy `production-release.ps1` (`production_worker_deploy=true`) is refused while the `holding_page` drift exists (see §2) | Backup first, then apply, wrangler, `--check`. Runtime stays `check` (no first-request auto-migrate). |
| EmDash collection/field model | Cursor EmDash MCP (`schema_*` / content tools) against staging, then production | Not `npx emdash schema` for agents. Apply the same collection/field operations to production after staging validation. |
| EmDash content changes | Staging-to-production promotion | Use [web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md) |

## Prerequisites

1. Changes are merged to `main` (or ready for manual workflow dispatch).
2. `gh` authenticated (`gh auth status`).
3. EmDash staging and production API tokens available.
4. Staging validation complete for schema/content and page rendering.
5. Turso CLI access for production rollback checkpoints — **WSL on Windows, native `turso` on Linux** (**[docs/CLI_PATHS_WINDOWS.md](docs/CLI_PATHS_WINDOWS.md)**, AGENTS.md §7). Required for schema/content promotion and for reading CI rollback metadata; **local full production deploy** (`deploy-production-local.ps1`) creates a checkpoint automatically unless you pass `-SkipTursoBackup`. CI mutate (`production_worker_deploy=true`) also creates a Turso rollback branch and uploads the metadata artifact. **Cloud VM:** see **[web/docs/CLOUD_AGENT_DEPLOY_ISSUES.md](web/docs/CLOUD_AGENT_DEPLOY_ISSUES.md)** (CA-14…CA-17) — do not use `wsl`; do not skip backup because snapshot JSON files have 1970 mtimes; local deploy pins `EMDASH_TARGET_FINGERPRINT` from `--status` (CI still uses `EMDASH_TARGET_FINGERPRINT_PRODUCTION`).

Merge rule for EmDash-dependent changes:

- If a PR changes code that depends on EmDash schema, production schema must be synced before the PR is closed and before allowing the `main` deployment to proceed.
- Treat schema sync as a deployment prerequisite for those PRs, not as optional cleanup after merge.

Recommended env vars for content/schema operations:

```powershell
$env:EMDASH_STAGING_URL = "https://staging.freedomtimes.news"
$env:EMDASH_PRODUCTION_URL = "https://freedomtimes.news"
$env:EMDASH_STAGING_TOKEN = "<staging-token>"
$env:EMDASH_PRODUCTION_TOKEN = "<production-token>"
```

1. **Turso rollback checkpoint** — see [Section 1](#1-create-turso-rollback-checkpoint-mandatory-before-production-schema-or-content-changes). Required before production schema/content work. Local full deploy creates it automatically unless `-SkipTursoBackup`.

## 1. Create Turso rollback checkpoint (mandatory before production schema or content changes)

This is mandatory before any production schema change, migration, or content promotion.

Why:

1. Turso branches are full, isolated database copies that give you a clean pre-release fallback point.
2. If a deployment introduces bad schema/data state, you can quickly move production runtime back to the checkpoint database.
3. This reduces data rollback risk compared with trying to manually reverse multiple changes under pressure.

Create a checkpoint branch from the production database before doing anything else:

**GitHub Actions release path** (`production-release.ps1`) and **schema/content promotion** — run manually:

```powershell
pwsh ./scripts/backup-production-emdash.ps1 -AllowProduction
# Creates Turso branch prod-backup-YYYYMMDD-HHMMSS from the Worker-resolved DB
# (never assume named freedomtimes-emdash-production). Commit the agents log.
```

**Local full production deploy** — automatic before Terraform apply (unless skipped):

```powershell
pwsh ./scripts/deploy-production-local.ps1
# Opt out: pwsh ./scripts/deploy-production-local.ps1 -SkipTursoBackup
```

**Resolve the Worker Turso host first** (`node web/scripts/resolve-production-worker-turso.mjs`). Do not default to `freedomtimes-emdash-production` (that named DB has been a stale thin corpus while the Worker used another branch). Turso group defaults from `TF_VAR_TURSO_DATABASE_GROUP_PRODUCTION` (fallback: `freedomtimes-production`). Metadata is written under `.release/rollback-branches/`. **Commit** the operator log `freedomtimes-agents/data/backups/prod-emdash-YYYYMMDD-HHMMSS.json`. Disaster recovery (canonical): sibling [freedomtimes-agents/docs/DISASTER_RECOVERY.md](../freedomtimes-agents/docs/DISASTER_RECOVERY.md) — retarget Worker; do not overwrite named production first.

Record these with the release notes:

1. backup Turso branch name (`prod-backup-YYYYMMDD-HHMMSS`)
2. creation timestamp
3. Worker-resolved source database name

The metadata file written to `.release/rollback-branches` includes:

1. rollback database name and creation timestamp
2. git HEAD hash and short hash
3. `origin/main` hash
4. current branch and dirty working tree flag

Important Turso behavior:

1. Branches are separate databases and do not auto-merge back.
2. You need branch-specific credentials (token/group token) to connect.
3. Delete old rollback branches after the release stabilizes to avoid quota sprawl.

Do not proceed to schema promotion or content promotion unless this checkpoint exists.

## 2. Deploy Code, Layout, EmDash Runtime, and Terraform

Do not run this step for EmDash-dependent code until Step 3 shows production schema is already in sync or has just been synced.

### 2a. Standard: GitHub Actions (`deploy-worker.yml`)

Web Worker releases go through a PR: the PR deploys staging, the operator checks staging and merges, and the merge runs a verified production Turso backup (Turso branch `prod-backup-YYYYMMDD-HHMMSS` only; no `.db` or artifact from CI) and then the production Worker deploy. Steps, secrets and restore: **[web/docs/DEPLOY.md § Standard path](web/docs/DEPLOY.md#standard-path-github-actions-deploy-workeryml)** (the one place that defines it). This workflow never applies Terraform; see the Terraform row above.

### Legacy: Terraform dispatch (`production-release.ps1`)

Not the standard Worker deploy. From repo root:

```powershell
.\scripts\production-release.ps1 -TerraformMode apply -Watch -AllowProduction
```

What this does:

1. Dispatches `.github/workflows/terraform-production.yml`.
2. Requests Terraform apply (`production_terraform_apply=true`) and Worker mutate (`production_worker_deploy=true`).
3. The workflow creates a recoverable Turso rollback branch (metadata artifact + job summary), applies tips/subscriptions/scheduler SQL, builds `web/` (writes `.emdash/migrations.json`), runs `npx emdash migrate` with `EMDASH_TARGET_FINGERPRINT_PRODUCTION`, deploys that same Worker build, then `npx emdash migrate --check`. Staging/production EmDash runtime stays on `check` (no first-request auto-migrate). A push to `main` or `-TerraformMode plan` does **not** mutate EmDash, SQL, or wrangler (Terraform plan + `emdash migrate --check` only).
4. Watches run completion and exits non-zero on failure.

**Refused while the Worker script drift exists.** Every plan after a local `wrangler deploy` shows the `holding_page` drift (`1 to change`, [NON_TERRAFORM_RESOURCES.md](NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift)). The workflow's `Guard Worker Script Upload Plan` refuses any CI apply that would re-upload the Worker script, so this dispatch fails at the guard before anything is applied, migrated or deployed. The workflow has no recovery or placement check for the gap before wrangler ([#116](https://github.com/cultpodcasts/freedomtimes/issues/116)). In practice, deploy with §2a (or the §2b fallback).

**Web version:** CI builds from committed `main` — no automatic bump. Local staging/production version behavior: [DEPLOY.md § Web version bump](web/docs/DEPLOY.md#web-version-bump-on-deploy). Bump and commit manually before dispatch if you want a new semver on the release build.

Plan-only dry path (Terraform plan + `emdash migrate --check` only — **no** Turso rollback branch, SQL `*:db:deploy`, EmDash apply, or wrangler):

```powershell
.\scripts\production-release.ps1 -TerraformMode plan -Watch -AllowProduction
```

### 2b. Local production deploy (fallback)

The fallback when the standard §2a path is unavailable (CI down, a full Terraform deploy, or the operator asks). It is also why the legacy CI apply is not needed: the CI apply in §2 is refused at the guard. Use **`scripts/deploy-production-local.ps1`**. **Script matrix, flags, step order, prerequisites, and troubleshooting:** [web/docs/DEPLOY.md — Local deploy scripts](web/docs/DEPLOY.md#local-deploy-scripts).

```powershell
pwsh ./scripts/deploy-production-local.ps1
```

**Release-specific notes (not duplicated in deploy guide):**

- Routine web Worker releases use §2a (`deploy-worker.yml`). Use this local path as the fallback. The legacy dispatch is refused while the `holding_page` drift exists; use it with `-TerraformMode plan` as a dry run.
- Local full deploy **and** `-WorkerOnly` auto-create a Turso rollback checkpoint, then `emdash migrate`, wrangler, `--check` (same sequence as CI).
- After deploy, post-deploy secret verify runs on the production web Worker (`AUTH0_*`, `EMDASH_*`) — see canonical doc if verify fails.

## 3. Step 1: Prove Production Matches Staging Schema Semantics

Schema changes are made on staging during development, not during the release. By release time, staging schema is already validated.

Step 1 of the production release is not merely "verify schema parity". Step 1 is to prove that production matches staging in the ways that actually control runtime behavior before any content promotion or dependent deploy is treated as safe.

Operational rule: if the branch contains code that expects new collections, fields, or collection behavior, production must match staging here before closing the PR or allowing the `main` deploy to become the source of truth.

What must match before proceeding:

1. Collection existence and field definitions.
2. Collection-level metadata and behavior, especially values such as `source`, `supports`, labels, and any collection settings that affect runtime/editor behavior.
3. Production manifest visibility for the touched collection.
4. Production admin route resolution for the touched collection.

This incident proved that field-level parity alone is insufficient. A collection can exist in both environments and still behave differently because collection metadata (`supports`, `source`, labels) drifted — not because of a stale manifest cache (removed in EmDash 0.9+).

The schema promotion script is still useful, but it is only one part of Step 1. It diffs staging vs production, presents the required CLI commands for human review, then applies additive changes after explicit confirmation.

No production schema mutation is allowed unless the rollback checkpoint from Step 1 already exists.

```powershell
.\scripts\promote-schema-to-production.ps1 -AllowProduction -RollbackMetadataFile .\.release\rollback-branches\<timestamp>-<rollback-db>.json
```

The script will:

1. Fetch the full schema (all collections + fields) from both staging and production.
2. Compute the diff: new collections, missing fields.
3. Print each generated command for human review.
4. Prompt `yes/no` before applying anything.
5. Warn about fields/collections present in production but absent in staging (never removes anything automatically).
6. Stop immediately on the first failure and report partial state.

The script does not currently prove collection metadata parity. It should be treated as an additive diff tool, not as the full Step 1 gate.

Dry-run (diff only, no apply):

```powershell
.\scripts\promote-schema-to-production.ps1 -AllowProduction -DryRun
```

Destructive operations (`schema delete`, `remove-field`) are never generated. If production has extra fields or collections that need removing, do that manually with the EmDash CLI after reviewing the diff output.

Required manual checks after the diff and before content promotion:

```powershell
# Confirm collection metadata in both environments
npx --prefix web emdash schema get archives -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash schema get archives -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

Then verify runtime visibility in production:

1. `/_emdash/api/manifest` contains the collection.
2. `/_emdash/admin/content/<collection>` resolves.
3. If manifest visibility is wrong even though schema looks correct, compare `_emdash_collections` metadata between staging and production before promoting content (see [CONTENT_PROMOTION_RUNBOOK.md §5](web/CONTENT_PROMOTION_RUNBOOK.md#5-recover-from-collection-not-found-admin-issues)). Do **not** rely on clearing `emdash:manifest_cache` — current EmDash builds the manifest from the live DB per request.

## 4. Promote EmDash Content Changes

Follow [web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md) for staging-to-production content promotion.

No content migration or content promotion starts until the rollback branch exists and Step 1 is complete.

This includes content-integrity controls, not just content existence:

1. Promotion must use a scripted UTF-8-safe path.
2. Manual copy/paste or ad hoc shell transfer of JSON payloads is not an approved production method.
3. Promoted text-bearing fields must be compared between staging and production before release sign-off.
4. Mojibake signatures such as `ΓÇ`, `â€™`, `â€œ`, `â€`, or `╬ô├ç├û` are release blockers.
5. If corruption is found in production while staging is clean, use `./scripts/repair-production-content-from-staging.ps1` with a rollback checkpoint rather than editing production content manually.

Minimal single-item example:

```powershell
# Validate source item on staging
npx --prefix web emdash content get posts example-post -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash content get posts example-post --published -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json

# Promote to production
npx --prefix web emdash content create posts --slug example-post --file .\tmp\example-post.json -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
npx --prefix web emdash content publish posts example-post -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Verify live production version
npx --prefix web emdash content get posts example-post --published -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

### Archives Releases Require Media Asset Validation (R2)

If the release includes `archives` content, content promotion alone is not sufficient. You must validate associated media assets.

Minimum checks:

1. Confirm production Worker has a valid `MEDIA` R2 binding for EmDash runtime.
2. Confirm each archive item's referenced media exists in production media storage.
3. Re-upload missing media to production before publishing archive entries.

Useful commands:

```powershell
# List production media records in EmDash
npx --prefix web emdash media list -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Get a specific media record by id
npx --prefix web emdash media get <media-id> -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Upload missing media file to production
npx --prefix web emdash media upload .\path\to\asset.png --alt "Archive cover" -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

## 5. Release Verification Checklist

1. Production workflow run is green.
2. Expected layout/UI change is visible on production route(s).
3. Schema parity checks pass for touched collections.
4. Promoted content is `--published` in production.
5. Public routes render updated content without fallback/manual repair.
6. For archives releases, linked media renders correctly and downloadable assets resolve from production.
7. For promoted content, staging and production text-bearing fields match for the released items.
8. No mojibake signatures appear in production content or rendered pages.

### 5b. Page cache & placement checks

Production serves an anonymous reader page cache and runs the Worker in `aws:eu-west-1` (see [`web/docs/EMDASH_MIDDLEWARE_AND_ROUTING.md`](web/docs/EMDASH_MIDDLEWARE_AND_ROUTING.md#anonymous-reader-page-cache-production-only)). After a deploy that ships or changes either:

1. **Placement active (Cloudflare API, not a header):** `cd web && node scripts/verify-worker-placement.mjs --env production --url "https://freedomtimes.news/?ft-verify=1"` (same with `--env staging` after a staging deploy; uses the first plausible token (40+ characters, no whitespace) from `CLOUDFLARE_API_TOKEN`, `TF_VAR_CLOUDFLARE_API_TOKEN`, `TF_VAR_cloudflare_api_token` in the environment, then `--env-file ../.env.dev`; short stubs are skipped and only the source name is printed, never the token). It must print `OK`: placement `mode=targeted region=aws:eu-west-1`, `PAGE_CACHE` / `SITE_ACCESS_MODE` equal to `web/wrangler.jsonc`, the `ASSETS` binding that `wrangler.jsonc` `assets.binding` names, `has_assets`, `last_deployed_from=wrangler`, a logged-out `/favicon.svg?ft-verify=<ms>` (cache-busted) HTTP 200 (non-HTML) and a non-5xx `/__ft-verify/no-such-route/a/b` on the environment's own origin, each retried up to 4 times 5 s apart before it counts, every attempt's status logged (see [NON_TERRAFORM_RESOURCES.md](NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift)). The `--url` sample (query string so the page cache returns `BYPASS-query` and the request reaches the DB) is a sanity check on `Server-Timing` (`db.total` / `db.count`): placed next to the Turso primary the warm median is well under 60 ms per query (it was ~90 ms per round trip from the US before placement). Do **not** look for a `cf-placement` response header: Cloudflare documents it "may be removed" and it is not emitted for this Worker ([placement docs](https://developers.cloudflare.com/workers/configuration/placement/#check-placement-status)). `deploy-*-local.ps1` runs this check automatically after `wrangler deploy`.
2. **Terraform does not fight placement:** `terraform plan` in `infra/terraform/environments/staging` (then production) shows **no** Terraform-owned change on `cloudflare_workers_script.holding_page` other than the expected binding drift (`~ bindings = (sensitive value)`, "1 to change"). That drift is expected but **not safe to apply on its own**: read [NON_TERRAFORM_RESOURCES.md § Terraform drift on the Worker script](NON_TERRAFORM_RESOURCES.md#terraform-holding-page-drift) before any apply. `placement` is in `lifecycle.ignore_changes` (Wrangler owns it). Plan only from agents; never apply.
   - **After any `terraform apply` (staging or production)** follow the same section: `scripts/terraform-run.ps1` blocks a Worker-script upload before apply, and after apply exits 4 (mismatch) or 5 (could not verify) with the Wrangler redeploy command.
3. **MISS → HIT:** two anonymous requests to `/` (no cookies, no query string) return `x-ft-cache: MISS` then `x-ft-cache: HIT`. A request with any query string returns `BYPASS-query`; a signed-in browser shows `BYPASS-cookie`.
4. **Purge on the next real publish:** after the next publish, `/` returns `MISS` (new epoch) within ~40 s, at most 120 s, and shows the new post. Worker logs show `[ft-page-cache] epoch bumped`.
5. **Analytics country:** in Admin → Analytics, page-view country breakdown does not collapse to IE/GB after placement (country is read from the eyeball request, not the placed colo).
6. **Staleness from non-content changes:** SQL migrations, redirects inserted by SQL, menus and site settings do not purge; anonymous readers may see the old page for up to the TTL (120 s). If that matters, bump the epoch manually (below).

**Kill switch / manual purge**

- Disable the cache: set `PAGE_CACHE` to `off` in `web/wrangler.jsonc` `env.production.vars` and redeploy (cache lookups stop immediately; entries age out within the TTL).
- Purge everything without a deploy: write a new value to KV key `ft:page-cache:epoch` in the production `SESSION` namespace (for example `wrangler kv key put --env production --binding SESSION ft:page-cache:epoch "$(date +%s)" --remote`). Every colo misses within ~40 s.

## 6. Rollback Strategy

**Prefer sibling [freedomtimes-agents/docs/DISASTER_RECOVERY.md](../freedomtimes-agents/docs/DISASTER_RECOVERY.md):** identify last verified `prod-backup-*` (or legacy `prod-rollback-*`) / agents log, then **retarget the Worker** to that branch. Do not restore onto named production as the first step.

1. Revert code on `main` and re-run production workflow.
2. If data rollback is needed, switch production runtime from the current Worker Turso credentials to the pre-release Turso rollback branch credentials (`pwsh ./scripts/disaster-recover-production-emdash.ps1 -AllowProduction -FromBranch <name>`).

```powershell
.\scripts\switch-production-turso-secrets.ps1 \
	-DatabaseUrl <rollback-libsql-url> \
	-AuthToken <rollback-db-token> \
	-DatabaseName <rollback-db-name> \
	-SyncGitHub \
	-AllowProduction
```

3. For content rollback, re-publish previous content revision or restore previous item state in EmDash.
4. For schema rollback, apply reverse CLI operations (for example remove newly-added field) only after impact review.
