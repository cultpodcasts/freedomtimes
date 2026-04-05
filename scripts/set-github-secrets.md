# set-github-secrets.ps1 Usage Guide

Purpose: sync GitHub secrets/variables and Cloudflare Worker secrets from local env files.

This guide is for Copilot sessions and operators so the script is used consistently and safely.

## Script Location

- `scripts/set-github-secrets.ps1`

## What It Supports

Parameters:

- `-Target Staging|Production` (default: `Staging`)
- `-SyncCloudflareWorkerSecrets` (pushes Worker secrets with Wrangler)
- `-DryRun` (prints actions without writing)
- `-AllowProduction` (required guardrail bypass for production)

## Environment Files Read

The script reads and merges these files from repo root:

- `.env.dev` (base)
- `.env.staging` (staging overrides)
- `.env.production` (production overrides)

For Worker secret sync, staging values are resolved from these keys:

- `AUTH0_DOMAIN` (or fallback `TF_VAR_auth0_domain`)
- `AUTH0_LOGIN_APP_CLIENT_ID` (or fallback `AUTH0_CLIENT_ID`)
- `AUTH0_LOGIN_APP_CLIENT_SECRET` (or fallback `AUTH0_CLIENT_SECRET`)

Worker secret names written:

- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`

## Standard Staging Command

Run from repo root:

```powershell
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
```

Dry run:

```powershell
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets -DryRun
```

## Production Command (Guarded)

Production updates are blocked unless `-AllowProduction` is passed.

```powershell
.\scripts\set-github-secrets.ps1 -Target Production -SyncCloudflareWorkerSecrets -AllowProduction
```

Use only with explicit approval.

## Verification

After staging sync, verify secret names only:

```powershell
npx wrangler secret list --config .\web\wrangler.jsonc --env staging
```

Expected names:

- `AUTH0_DOMAIN`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`

## Known Operational Notes

- Run from repo root so relative env paths resolve correctly.
- Ensure Wrangler auth is active (`npx wrangler whoami`).
- If `/auth/login` returns 500 after deploy, first verify staging secret names using the command above.
- Current script emits verbose debug output. Do not paste logs containing secret values into tickets, chat, or commits.
