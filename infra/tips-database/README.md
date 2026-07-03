# Tips database (Turso / libSQL)

Dedicated Turso database for **anonymous or identified editorial story tips** (`/submit-a-tip`).

| Table | Purpose |
|-------|---------|
| `story_tips` | Reader story tips (anonymous or identified contact fields) |

Notification troubleshooting reports ("Report a problem") are stored in the **subscriptions** database — see `infra/subscriptions-database/migrations/20260702_create_notification_diagnostics.sql` and [web/docs/PUSH_NOTIFICATIONS_OPERATOR.md](../../web/docs/PUSH_NOTIFICATIONS_OPERATOR.md).

## Why separate from subscriptions?

The **subscriptions** database holds push notification endpoints, delivery metadata, and notification diagnostic reports. Story tips have different retention, access, and privacy requirements — they live here instead.

## Terraform

Turso databases are provisioned per environment in:

- `infra/terraform/environments/staging/main.tf`
- `infra/terraform/environments/production/main.tf`

Default names:

| Environment | Database name |
|-------------|---------------|
| Staging | `freedomtimes-tips-staging` |
| Production | `freedomtimes-tips-production` |

## Worker secrets (Astro web Worker)

The site Worker reads tips via **libSQL over HTTPS** (same pattern as subscriptions — not a Wrangler D1 binding):

| Secret | Purpose |
|--------|---------|
| `TURSO_TIPS_DATABASE_URL` | libsql:// URL |
| `TURSO_TIPS_AUTH_TOKEN` | Database JWT |

Local `.env.dev` staging keys: `TURSO_STAGING_TIPS_DB_URL`, `TURSO_STAGING_TIPS_DB_TOKEN`.

Production `.env.dev` aliases: `TURSO_TIPS_DATABASE_URL`, `TURSO_TIPS_AUTH_TOKEN`, plus `TURSO_PRODUCTION_TIPS_DB_*`.

## Migrations

**Back up first** (see `web/CONTENT_PROMOTION_RUNBOOK.md` — Turso backups before mutating work):

```powershell
# Example: export before first migrate
wsl bash -lc 'turso db export freedomtimes-tips-staging --output-file ./.release/backups/tips-staging-$(date +%Y%m%d).db'
```

From `web/`:

```powershell
# Staging (set TURSO_STAGING_TIPS_DB_* in .env.dev after terraform apply + sync)
npm run tips:db:deploy:staging

# Or migrate only
npm run tips:db:migrate:staging
```

When GitHub CI is available it runs `npm run tips:db:deploy` after Terraform apply; **if CI is down**, use the local steps in [web/docs/STORY_TIPS_OPERATOR.md](../../web/docs/STORY_TIPS_OPERATOR.md) (section *Local staging rollout*).

## Operator checklist (new environment)

1. `terraform apply` in staging or production (creates Turso DB + token).
2. Sync `.env.dev`: `pwsh scripts/sync-staging-turso-env-dev.ps1` (staging tips keys added automatically when outputs exist).
3. Apply migrations: `npm run tips:db:deploy` from `web/`.
4. Set Worker secrets: `TURSO_TIPS_DATABASE_URL`, `TURSO_TIPS_AUTH_TOKEN` via `pwsh scripts/set-github-secrets.ps1 -SyncCloudflareWorkerSecrets -Target Staging` (Cloudflare only; no GitHub Actions required).
5. Optional: Cloudflare Turnstile keys (see `web/docs/STORY_TIPS_OPERATOR.md`).

