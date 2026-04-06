# Staging Recovery Checklist

Use this when staging is destroyed and needs to be rebuilt from local with minimal friction.

## 1. Run one-command local staging rebuild

Run from repo root:

```powershell
.\scripts\staging-rebuild-local.ps1
```

This script runs the full local staging flow in deterministic order:

- applies Terraform for staging
- auto-recovers APIM custom-domain state drift by importing `azurerm_api_management_custom_domain.editorial[0]` when needed, then re-applies
- verifies Terraform-created Auth0 login app credentials are synced into `.env.dev` (`AUTH0_LOGIN_APP_CLIENT_ID_STAGING`, `AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING`) and that client ID matches Terraform output
- syncs Cloudflare Worker secrets using `set-github-secrets.ps1`
- deploys Worker via Wrangler
- deploys Function App via `func ... --build remote`
- verifies required Worker secrets and Function triggers exist

This replaces the old manual sequence and eliminates the common "stuck stage" around APIM custom-domain/state mismatch.

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
npx wrangler tail freedomtimes-holding-staging --format pretty
```

## Production Notes

- Production secret updates remain guarded and require explicit approval (`-AllowProduction`).
- Apply the same sequence for production, but only after explicit approval and with production commands.
