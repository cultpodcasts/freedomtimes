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
5. Turso CLI access available for production rollback checkpoints.

Recommended env vars for content/schema operations:

```powershell
$env:EMDASH_STAGING_URL = "https://staging.freedomtimes.news"
$env:EMDASH_PRODUCTION_URL = "https://freedomtimes.news"
$env:EMDASH_STAGING_TOKEN = "<staging-token>"
$env:EMDASH_PRODUCTION_TOKEN = "<production-token>"
```

## 1. Create Turso Rollback Checkpoint (Recommended Before Every Production Apply)

Yes, this should be done before production deployments.

Why:

1. Turso branches are full, isolated database copies that give you a clean pre-release fallback point.
2. If a deployment introduces bad schema/data state, you can quickly move production runtime back to the checkpoint database.
3. This reduces data rollback risk compared with trying to manually reverse multiple changes under pressure.

Create a checkpoint branch from the production database:

```powershell
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$rollbackDb = "prod-rollback-$timestamp"
turso db create $rollbackDb --from-db <production-database-name>
```

Record these with the release notes:

1. rollback database name
2. creation timestamp
3. source production database name

Important Turso behavior:

1. Branches are separate databases and do not auto-merge back.
2. You need branch-specific credentials (token/group token) to connect.
3. Delete old rollback branches after the release stabilizes to avoid quota sprawl.

## 2. Deploy Code, Layout, EmDash Runtime, and Terraform

From repo root:

```powershell
.\scripts\production-release.ps1 -TerraformMode apply -Watch -AllowProduction
```

What this does:

1. Dispatches `.github/workflows/terraform-production.yml`.
2. Requests Terraform apply (`production_terraform_apply=true`).
3. Watches run completion and exits non-zero on failure.

Plan-only dry path:

```powershell
.\scripts\production-release.ps1 -TerraformMode plan -Watch -AllowProduction
```

## 3. Promote EmDash Schema Changes

Apply schema changes to staging first, then mirror the same operations to production.

Examples:

```powershell
# Create collection
npx --prefix web emdash schema create posts --label "Posts" -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash schema create posts --label "Posts" -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

# Add field
npx --prefix web emdash schema add-field posts teaser --type text --label "Teaser" -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash schema add-field posts teaser --type text --label "Teaser" -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

Parity checks after schema promotion:

```powershell
npx --prefix web emdash schema list -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash schema list -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json

npx --prefix web emdash schema get posts -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
npx --prefix web emdash schema get posts -u $env:EMDASH_PRODUCTION_URL -t $env:EMDASH_PRODUCTION_TOKEN --json
```

## 4. Promote EmDash Content Changes

Follow [web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md) for staging-to-production content promotion.

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

## 5. Release Verification Checklist

1. Production workflow run is green.
2. Expected layout/UI change is visible on production route(s).
3. Schema parity checks pass for touched collections.
4. Promoted content is `--published` in production.
5. Public routes render updated content without fallback/manual repair.

## 6. Rollback Strategy

1. Revert code on `main` and re-run production workflow.
2. If data rollback is needed, switch production runtime from the primary database credentials to the pre-release Turso rollback branch credentials, then redeploy.
3. For content rollback, re-publish previous content revision or restore previous item state in EmDash.
4. For schema rollback, apply reverse CLI operations (for example remove newly-added field) only after impact review.
