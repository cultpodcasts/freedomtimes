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
| Layout/UI changes (`web/src/**`) | `terraform-production.yml` workflow | Includes Worker build/deploy and required runtime vars/secrets sync |
| EmDash runtime updates (`web` dependencies/config) | `terraform-production.yml` workflow | Same workflow deploys updated Worker bundle |
| Terraform/IaC changes (`infra/terraform/**`) | `terraform-production.yml` workflow (plan/apply) | Applies managed infrastructure and captures outputs |
| EmDash schema changes | EmDash CLI against staging, then production | Apply same collection/field operations to production after staging validation |
| EmDash content changes | Staging-to-production promotion | Use [web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md) |

## Prerequisites

1. Changes are merged to `main` (or ready for manual workflow dispatch).
2. `gh` authenticated (`gh auth status`).
3. EmDash staging and production API tokens available.
4. Staging validation complete for schema/content and page rendering.
5. Turso CLI access in **WSL** for production rollback checkpoints — **[docs/CLI_PATHS_WINDOWS.md](docs/CLI_PATHS_WINDOWS.md)** (primary reference for WSL invoke patterns).

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

1. **Turso rollback checkpoint** — same as [Section 1](#1-create-turso-rollback-checkpoint-mandatory-before-production-schema-or-content-changes) before mutating production data or schema.

This is mandatory before any production schema change, migration, or content promotion.

Why:

1. Turso branches are full, isolated database copies that give you a clean pre-release fallback point.
2. If a deployment introduces bad schema/data state, you can quickly move production runtime back to the checkpoint database.
3. This reduces data rollback risk compared with trying to manually reverse multiple changes under pressure.

Create a checkpoint branch from the production database before doing anything else:

```powershell
.\scripts\turso-create-rollback-branch.ps1 -ProductionDatabaseName <production-database-name> -AllowProduction
```

Record these with the release notes:

1. rollback database name
2. creation timestamp
3. source production database name

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

From repo root:

```powershell
.\scripts\production-release.ps1 -TerraformMode apply -Watch -AllowProduction
```

What this does:

1. Dispatches `.github/workflows/terraform-production.yml`.
2. Requests Terraform apply (`production_terraform_apply=true`).
3. Watches run completion and exits non-zero on failure.

**Web version:** `terraform-production.yml` builds `web/` from whatever is already committed on `main` — this script does not bump or commit `web/package.json` for you. If you want the deployed build to carry a bumped version, bump and commit it first (`cd web && npm version patch --no-git-tag-version --allow-same-version && cd .. && git add web/package.json web/package-lock.json && git commit -m "chore: bump web version" && git push`). Of the local bypass scripts, only the **staging** ones (`deploy-staging-workers-only.ps1`, `deploy-staging-worker-local.ps1`, `staging-rebuild-local.ps1`) bump `web/package.json` automatically before their own build step (patch bump, uncommitted — pass `-SkipVersionBump` to opt out). The **production** ones (`deploy-production-worker-local.ps1`, `production-rebuild-local.ps1`) default to **no bump** — they ship the same version staging already bumped for this release; pass `-BumpVersion` to bump anyway. See [web/docs/DEPLOY_TROUBLESHOOTING.md § Web version bump on deploy](web/docs/DEPLOY_TROUBLESHOOTING.md#web-version-bump-on-deploy).

Plan-only dry path:

```powershell
.\scripts\production-release.ps1 -TerraformMode plan -Watch -AllowProduction
```

### 2b. Local production rebuild (operator bypass)

1. **Turso rollback checkpoint** — same as [Section 1](#1-create-turso-rollback-checkpoint-mandatory-before-production-schema-or-content-changes) before mutating production data or schema.

From repo root:

```powershell
pwsh ./scripts/production-rebuild-local.ps1
```

Optional: `-BumpVersion` to bump `web/package.json` before build (default is no bump; staging usually already bumped for the release). See [web/docs/DEPLOY_TROUBLESHOOTING.md — Web version bump on deploy](web/docs/DEPLOY_TROUBLESHOOTING.md#web-version-bump-on-deploy).

**Prerequisites**

1. **Turso rollback checkpoint** — same as [Section 1](#1-create-turso-rollback-checkpoint-mandatory-before-production-schema-or-content-changes) before mutating production data or schema.
2. **Production push secrets in `.env.dev`** - Production VAPID keys plus FCM credentials (`PUSH_PRODUCTION_ANDROID_FCM_*` or `PUSH_STAGING_ANDROID_FCM_*` fallback; same as `scripts/assert-push-secrets-ready.ps1`). Staging rebuild preflight uses the same FCM checks. Run `pwsh ./scripts/populate-android-fcm-env.ps1` or copy values per [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md).
3. **Cloudflare API token** — non-interactive Terraform and Wrangler (see [DEPLOY_TROUBLESHOOTING.md](web/docs/DEPLOY_TROUBLESHOOTING.md)).

**Troubleshooting:** [web/docs/DEPLOY_TROUBLESHOOTING.md](web/docs/DEPLOY_TROUBLESHOOTING.md) (FCM preflight, Auth0 env sync, Turso secrets after worker rename, Wrangler cwd, Terraform worker lifecycle).


## 3. Step 1: Prove Production Matches Staging Schema Semantics

Schema changes are made on staging during development, not during the release. By release time, staging schema is already validated.

Step 1 of the production release is not merely "verify schema parity". Step 1 is to prove that production matches staging in the ways that actually control runtime behavior before any content promotion or dependent deploy is treated as safe.

Operational rule: if the branch contains code that expects new collections, fields, or collection behavior, production must match staging here before closing the PR or allowing the `main` deploy to become the source of truth.

What must match before proceeding:

1. Collection existence and field definitions.
2. Collection-level metadata and behavior, especially values such as `source`, `supports`, labels, and any collection settings that affect runtime/editor behavior.
3. Production manifest visibility for the touched collection.
4. Production admin route resolution for the touched collection.

This incident proved that field-level parity alone is insufficient. A collection can exist in both environments and still behave differently because collection metadata drifted or the persisted manifest cache is stale.

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
3. If manifest visibility is wrong even though schema looks correct, clear `emdash:manifest_cache` and re-check before promoting content.

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

## 6. Rollback Strategy

1. Revert code on `main` and re-run production workflow.
2. If data rollback is needed, switch production runtime from the primary database credentials to the pre-release Turso rollback branch credentials.

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
