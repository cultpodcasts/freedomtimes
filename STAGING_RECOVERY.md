# Staging Recovery Checklist

Use this when staging is destroyed and needs to be rebuilt from local with minimal friction.

## 1. Rebuild staging infrastructure from local Terraform

Run from repo root:

```powershell
.\scripts\terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles -AutoApprove
```

This applies Terraform using `.env.dev` values.

## 2. Sync Terraform-created Auth0 login app credentials into `.env.dev`

This is now automatic when step 1 succeeds.

`terraform-run.ps1` writes these staging keys in `.env.dev` from Terraform state:

- `AUTH0_LOGIN_APP_CLIENT_ID_STAGING`
- `AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING`

No manual Auth0 dashboard copy is required for staging recovery.

## 3. Sync Cloudflare Worker secrets for staging

Run from repo root:

```powershell
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
```

This writes Worker secrets:

- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`

## 4. Deploy worker

Run:

```powershell
cd web
npx wrangler deploy --config wrangler.jsonc --env staging
```

## 5. Verify

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
