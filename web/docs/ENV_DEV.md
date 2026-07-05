# Local environment files (`.env.dev` + `web/.env`)

Freedom Times uses **two** local env files. They are not interchangeable.

| File | Template | Loaded by |
|------|----------|-----------|
| **Repo-root `.env.dev`** | [`.env.dev.example`](../../.env.dev.example) | Terraform helpers (`scripts/terraform-*.ps1`), `scripts/set-github-secrets.ps1`, Turso sync scripts, operator scripts under `web/scripts/` via [`load-env-dev.mjs`](../scripts/lib/load-env-dev.mjs), Android signing in `web/android/` |
| **`web/.env`** | [`web/.env.example`](../.env.example) | `npm run dev` / Astro (Vite) — Auth0 runtime names for the local dev server |

Never commit `.env.dev`, `web/.env`, `.env.staging`, or `.env.production`.

---

## Quick setup

From the repository root:

```powershell
# 1. Operator + build secrets (Turso, Terraform, push, GitHub/Worker sync)
Copy-Item .env.dev.example .env.dev

# 2. Auth0 vars for the local Astro dev server
Copy-Item web\.env.example web\.env
```

Fill placeholders manually or refresh from infrastructure (below). For Auth0 field names in `web/.env`, see [AUTH.md](./AUTH.md).

### Turso URLs and tokens

After `.env.dev` exists, refresh database URLs/tokens from Terraform:

```powershell
# Staging scheduler + subscriptions + tips → TURSO_STAGING_* keys
pwsh ./scripts/sync-staging-turso-env-dev.ps1

# Production EmDash + scheduler + subscriptions + tips → TURSO_DATABASE_URL, TURSO_* aliases
pwsh ./scripts/sync-production-turso-env-dev.ps1
```

Production tokens can also be pulled from deployed Workers:

```powershell
node web/scripts/pull-production-turso-secrets.mjs
```

**Local staging Terraform** (`terraform-run.ps1 -Environment staging`) needs a **Platform API** token in `.env.dev` as **`TURSO_TOKEN_STAGING`** (same value as the GitHub Actions secret). This is not the same as `TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN` or other database JWTs. Copy from GitHub → Settings → Secrets → `TURSO_TOKEN_STAGING`, or create one in Turso → Settings → API tokens.

`astro.config.ts` requires **`TURSO_DATABASE_URL`** and **`TURSO_AUTH_TOKEN`** at startup (EmDash CMS). Those live in `.env.dev` after production sync. For `npm run dev`, either:

- copy those two keys into `web/.env`, or
- run with repo-root env loaded:

```powershell
cd web
npx --yes dotenv-cli -e ..\.env.dev -- npm run dev
```

Same pattern applies to `npm run build` (see [SOCIAL_IMAGES_AND_FAVICONS.md](./SOCIAL_IMAGES_AND_FAVICONS.md)).

---

## Where values come from

| Category | `.env.dev` keys (examples) | Source |
|----------|------------------------------|--------|
| Cloudflare API / zone | `TF_VAR_CLOUDFLARE_*` | Cloudflare dashboard → API tokens |
| Auth0 tenant + Management API | `TF_VAR_AUTH0_DOMAIN`, `TF_VAR_AUTH0_MANAGEMENT_*` | Auth0 dashboard; see [NON_TERRAFORM_RESOURCES.md](../../NON_TERRAFORM_RESOURCES.md) |
| Auth0 login app (per env) | `AUTH0_LOGIN_APP_CLIENT_ID_STAGING`, `_PRODUCTION`, secrets | Terraform outputs after `terraform apply`; `scripts/terraform-run.ps1` can write staging keys into `.env.dev` |
| EmDash Turso (CMS) | `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | `sync-production-turso-env-dev.ps1` or Terraform production outputs |
| Scheduler / subscriptions / tips Turso | `TURSO_STAGING_*`, `TURSO_SUBSCRIPTIONS_*`, `TURSO_SCHEDULER_*`, `TURSO_STAGING_TIPS_DB_*`, `TURSO_TIPS_*`, `TURSO_PRODUCTION_TIPS_DB_*` | `sync-staging-turso-env-dev.ps1`, `sync-production-turso-env-dev.ps1` |
| Turso Platform API (Terraform create DBs) | **`TURSO_PLATFORM_API_TOKEN`** or `TF_VAR_turso_api_token` (production); **`TURSO_TOKEN_STAGING`** (staging) | Turso dashboard → Settings → API tokens — **not** a libsql DB JWT (`eyJ…`). Do not copy `TURSO_AUTH_TOKEN` into `TURSO_TOKEN` / `TURSO_PLATFORM_API_TOKEN`. |
| Turso Platform API (mint DB JWTs) | `TF_VAR_TURSO_ORGANIZATION` | Turso dashboard → organization slug |
| Push (VAPID, FCM, APNs) | `PUSH_STAGING_*`, `PUSH_PRODUCTION_*` | Generated locally or synced via `set-github-secrets.ps1`; full key reference in [PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md) Section A |
| Local dev Auth0 runtime | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, … in **`web/.env`** | Map from staging login app credentials (`AUTH0_LOGIN_APP_CLIENT_ID_STAGING` → `AUTH0_CLIENT_ID`, etc.) or Auth0 dashboard |

Sync `.env.dev` to GitHub Actions and Cloudflare Worker secrets:

```powershell
pwsh ./scripts/set-github-secrets.ps1
pwsh ./scripts/set-github-secrets.ps1 -SyncCloudflareWorkerSecrets -Target Staging
```

Details: [ENVIRONMENT_SETUP.md](../../ENVIRONMENT_SETUP.md) (teardown/rebuild, secret categories), [scripts/set-github-secrets.md](../../scripts/set-github-secrets.md).

---

## Related docs

- [PUSH_NOTIFICATIONS_OPERATOR.md](./PUSH_NOTIFICATIONS_OPERATOR.md) — Section A: every `.env.dev` key used by push operator scripts
- [AUTH.md](./AUTH.md) — `web/.env` Auth0 variables for local login
- [ENVIRONMENT_SETUP.md](../../ENVIRONMENT_SETUP.md) — full environment lifecycle
- [SECRET_MANAGEMENT.md](../../SECRET_MANAGEMENT.md) — `.env.dev` + `.env.staging` / `.env.production` overlays

