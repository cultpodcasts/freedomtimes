# Staging Recovery Checklist

Use this when staging is destroyed and needs to be rebuilt from local with minimal friction.

Deploy failures (FCM keys, Turso secrets after worker rename, wrangler cwd, Terraform lifecycle, Cloudflare token): **[web/docs/DEPLOY.md](web/docs/DEPLOY.md)**.

**CLI paths:** Terraform on Windows; Turso in WSL. Primary reference: **[docs/CLI_PATHS_WINDOWS.md](docs/CLI_PATHS_WINDOWS.md)**.

## 1. Run one-command local staging deploy

Run from repo root:

```powershell
.\scripts\deploy-staging-local.ps1
```

This runs the full local staging deploy in deterministic order. **Script matrix, flags, and step order:** [web/docs/DEPLOY.md — Local deploy scripts](web/docs/DEPLOY.md#local-deploy-scripts).

**Recovery-specific notes:**

- **Turso backup:** not included on staging full deploy. For risky staging DB work, create a rollback branch manually (`turso-create-rollback-branch.ps1` with staging database name) before deploy.
- **Scheduler / Azure Function:** full deploy and `-WorkerOnly` do **not** deploy the scheduler worker or Azure Function App. Use `-WorkersOnly` or manual steps (§2.5) when needed.
- **Web + scheduler without Terraform:** `deploy-staging-local.ps1 -WorkersOnly`.

## 2. If you need to run steps manually

Use this only for debugging. Default to step 1 above.

### 2.1 Apply Terraform

```powershell
.\scripts\terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles -AutoApprove
```

### 2.2 Confirm Terraform synced Auth0 staging credentials into `.env.dev`

`terraform-run.ps1` writes these keys during staging apply:

- `AUTH0_LOGIN_APP_CLIENT_ID_STAGING`
- `AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING`

If either key is missing, stop and re-run Terraform apply before syncing Worker secrets.

### 2.3 Sync Worker secrets

```powershell
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
```

### 2.4 Deploy Worker

```powershell
cd web
npx wrangler deploy --config wrangler.jsonc --env staging
```

### 2.5 Deploy Function

```powershell
cd functions/editorial-api
func azure functionapp publish freedomtimes-editorial-api-staging --javascript --build remote
```

## 3. Sync Terraform-created Auth0 login app credentials into `.env.dev`

This is now automatic when step 1 succeeds.

`terraform-run.ps1` writes these staging keys in `.env.dev` from Terraform state:

- `AUTH0_LOGIN_APP_CLIENT_ID_STAGING`
- `AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING`

No manual Auth0 dashboard copy is required for staging recovery.

## 4. Sync Cloudflare Worker secrets for staging

Run from repo root:

```powershell
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
```

This writes Worker secrets:

- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`

## 5. Deploy worker

Run:

```powershell
cd web
npx wrangler deploy --config wrangler.jsonc --env staging
```

## 6. Verify

- Secret names exist:

```powershell
npx wrangler secret list --config .\web\wrangler.jsonc --env staging
```

- Site responds:

```powershell
Invoke-WebRequest https://staging.freedomtimes.news -UseBasicParsing
```

- Optional logs:

```powershell
npx wrangler tail freedomtimes-staging --format pretty
```

## Renaming web Workers (remove `-holding`)

Historical names: `freedomtimes-holding-staging` → **`freedomtimes-staging`**, `freedomtimes-holding` → **`freedomtimes`**. Scheduler names are unchanged.

Wrangler deploy with a new `name` creates a **new** Worker script; the old script remains until deleted. Custom domains and zone routes are owned by Terraform (`module.cloudflare_holding_page`):

1. Update `TF_VAR_WORKER_NAME_STAGING` / `TF_VAR_WORKER_NAME_PRODUCTION` in `.env.dev` and GitHub repo variables.
2. Apply staging Terraform so `cloudflare_workers_domain` / `cloudflare_workers_route` point at the new script name.
3. Deploy the app: `.\scripts\deploy-staging-local.ps1 -WorkersOnly` (or full `deploy-staging-local.ps1`).
4. Verify `https://staging.freedomtimes.news` serves the new Worker (`npx wrangler deployments list --config web/wrangler.jsonc --env staging`).
5. Copy secrets to the new Worker if needed (`set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets`).
6. After production is migrated the same way, delete obsolete scripts in Cloudflare dashboard: **Workers & Pages → freedomtimes-holding-staging**, **freedomtimes-holding**.

Do **not** delete the old Worker until routes/custom domains are confirmed on the new name.

## Production Notes

- Production secret updates remain guarded and require explicit approval (`-AllowProduction`).
- Apply the same sequence for production, but only after explicit approval and with production commands.
