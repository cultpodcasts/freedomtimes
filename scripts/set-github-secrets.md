# set-github-secrets.ps1 Usage Guide

Purpose: sync GitHub secrets/variables and Cloudflare Worker secrets from local env configuration.

## Script Location

- `scripts/set-github-secrets.ps1`

## Supported Parameters

- `-Target Staging|Production` (default: `Staging`)
- `-SyncCloudflareWorkerSecrets` (pushes Worker secrets with Wrangler)
- `-SyncGitHubSecretsAndVars` (syncs GitHub repo secrets/vars)
- `-DryRun` (prints actions without writing)
- `-AllowProduction` (required guardrail bypass for production)

## Source of Truth

- `.env.dev` is the canonical source file.
- Staging and production values are selected using suffixed keys.

Worker secret sync key resolution:

- `AUTH0_DOMAIN` from `AUTH0_DOMAIN` (fallback `TF_VAR_auth0_domain`)
- staging client ID preference: `AUTH0_LOGIN_APP_CLIENT_ID_STAGING` -> `AUTH0_LOGIN_APP_CLIENT_ID` -> `AUTH0_CLIENT_ID`
- staging client secret preference: `AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING` -> `AUTH0_LOGIN_APP_CLIENT_SECRET` -> `AUTH0_CLIENT_SECRET`
- production client ID preference: `AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION` -> `AUTH0_LOGIN_APP_CLIENT_ID` -> `AUTH0_CLIENT_ID`
- production client secret preference: `AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION` -> `AUTH0_LOGIN_APP_CLIENT_SECRET` -> `AUTH0_CLIENT_SECRET`

Worker secret names written:

- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`

## Frictionless Local Staging Flow

Run from repo root:

```powershell
.\scripts\terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles -AutoApprove
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
cd web
npx wrangler deploy --config wrangler.jsonc --env staging
```

Why this works:

- `terraform-run.ps1` applies staging and syncs Terraform-created Auth0 login app credentials back to `.env.dev` (`AUTH0_LOGIN_APP_CLIENT_ID_STAGING`, `AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING`).
- `set-github-secrets.ps1` then pushes those current values to Worker secrets.

## Standard Staging Secret Sync

```powershell
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
```

Dry run:

```powershell
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets -DryRun
```

## Production Secret Sync (Guarded)

```powershell
.\scripts\set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction
```

Use only with explicit approval.

## Verification

List secret names only:

```powershell
npx wrangler secret list --config .\web\wrangler.jsonc --env staging
```

Expected names:

- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`

## Operational Notes

- Run from repo root so relative paths resolve correctly.
- Ensure Wrangler auth is active (`npx wrangler whoami`).
- Secret values are intentionally not printed by the sync script; only names/actions are logged.
