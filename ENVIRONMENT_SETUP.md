# Environment Setup & Configuration Guide

This guide documents how to manage Freedom Times environments locally and in CI/CD, including teardown, setup, secret synchronization, and multi-backend local development.

**Table of Contents:**
- [Environment Architecture](#environment-architecture)
- [Local Setup: Complete Teardown & Rebuild](#local-setup-complete-teardown--rebuild)
- [Syncing Secrets & Variables](#syncing-secrets--variables)
- [GitHub Actions Deployment Workflow](#github-actions-deployment-workflow)
- [Sync Script Reference](#sync-script-reference)
- [Adding a New Environment](#adding-a-new-environment)
- [Local Development](#local-development)

---

## Environment Architecture

### Current Environments

- **Staging**: `staging.freedomtimes.news`
  - Auth0 API: `https://api-staging.freedomtimes.news`
  - Cloudflare Worker: `freedomtimes-holding-staging`
  - Branched deployment: `feat/11-editorial-api-cosmos`

- **Production**: `freedomtimes.news`
  - Auth0 API: `https://api.freedomtimes.news`
  - Cloudflare Worker: `freedomtimes-holding`
  - Main branch deployment

### Infrastructure Components

Each environment includes:
- **Terraform Cloud**: Remote state (`freedomtimes-staging`, `freedomtimes-production`)
- **Azure Resources**: Function App, API Management (APIM), CosmosDB, Application Insights
- **Cloudflare**: DNS, Workers, custom domain for APIM gateway
- **Auth0**: Login app, API resource server, roles, scopes

---

## Local Setup: Complete Teardown & Rebuild

### Prerequisites

1. **Tools installed locally:**
   ```bash
   terraform >= 1.14.8
   azure-cli (az)
   pwsh (PowerShell 7+)
   github-cli (gh) - optional for GitHub manipulation
   ```

2. **Environment files ready:**
   - `.env.dev` (shared credentials)
   - `.env.staging` (staging-only values)
   - `.env.production` (production-only values)

   See [.env.dev.example section below](#env-dev-example) for what to include.

3. **Terraform Cloud token:**
   ```bash
   export TF_TOKEN_app_terraform_io=<your-terraform-cloud-token>
   ```

### 1. Destroy an Environment (Local)

**WARNING:** This deletes all infrastructure. Use with caution.

#### Before Destroy: Manual Cleanup

Auth0 automatically creates an "Application Insights Smart Detection" Action Group that blocks Terraform destroy. Delete it first:

```bash
# Get environment-specific resource group name
$rg = "freedomtimes-staging-rg"  # or "freedomtimes-production-rg"

# Delete the action group
az monitor action-group delete --resource-group $rg --name "Application Insights Smart Detection"
```

#### Destroy via Terraform

```bash
# Staging
cd c:\users\jonbr\source\repos\freedomtimes

.\scripts\terraform-run.ps1 `
  -Environment staging `
  -Operation destroy `
  -LoadEnvFiles `
  -AutoApprove

# Production (requires explicit approval flag)
.\scripts\terraform-run.ps1 `
  -Environment production `
  -Operation destroy `
  -LoadEnvFiles `
  -AutoApprove `
  -AllowProduction
```

**What gets destroyed:**
- All Azure resources (Function App, APIM, CosmosDB, etc.)
- Cloudflare DNS records and Workers
- Auth0 API resource server and credentials
- Terraform state becomes empty

#### Verify Complete Destruction

```bash
# Azure resource group should not exist
az group exists --name freedomtimes-staging-rg  # Should return 'false'

# Terraform state should be empty
terraform -chdir=infra/terraform/environments/staging state list  # No output
```

---

### 2. Deploy/Setup an Environment (Local)

#### Step 1: Load Environment Variables

```bash
cd c:\users\jonbr\source\repos\freedomtimes

# Load .env.dev, .env.staging, and merge into process environment
Get-Content .env.dev | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' -and $_ -notmatch '^#' } | ForEach-Object { $p = $_ -split '=',2; [System.Environment]::SetEnvironmentVariable($p[0].Trim(), $p[1].Trim(), 'Process') }

# If deploying production, also load .env.production
Get-Content .env.production | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' -and $_ -notmatch '^#' } | ForEach-Object { $p = $_ -split '=',2; [System.Environment]::SetEnvironmentVariable($p[0].Trim(), $p[1].Trim(), 'Process') }
```

#### Step 2: Initialize Terraform

```bash
# Staging
terraform -chdir=infra/terraform/environments/staging init -input=false

# Production
terraform -chdir=infra/terraform/environments/production init -input=false
```

#### Step 3: Plan & Apply

```bash
# Staging - Plan only (no apply)
.\scripts\terraform-run.ps1 `
  -Environment staging `
  -Operation plan `
  -LoadEnvFiles

# Staging - Plan and Apply
.\scripts\terraform-run.ps1 `
  -Environment staging `
  -Operation apply `
  -LoadEnvFiles

# Production - Plan only
.\scripts\terraform-run.ps1 `
  -Environment production `
  -Operation plan `
  -LoadEnvFiles `
  -AllowProduction

# Production - Plan and Apply
.\scripts\terraform-run.ps1 `
  -Environment production `
  -Operation apply `
  -LoadEnvFiles `
  -AllowProduction
```

#### Step 4: Deploy Cloudflare Worker Secrets

After Terraform apply completes, sync Auth0 credentials to the Cloudflare Worker:

```bash
# Staging
.\scripts\set-github-secrets.ps1 `
  -Target Staging `
  -SyncCloudflareWorkerSecrets

# Production
.\scripts\set-github-secrets.ps1 `
  -Target Production `
  -SyncCloudflareWorkerSecrets `
  -AllowProduction
```

This script:
1. Reads Auth0 login app credentials from `.env.dev` + `.env.staging/.env.production`
2. Uploads them to Cloudflare Worker via `npx wrangler secret put`

#### Step 5: Deploy the Function App

```bash
cd c:\users\jonbr\source\repos\freedomtimes\functions\editorial-api

# Get the function app name from Terraform output
$appName = (terraform -chdir=..\..\infra\terraform\environments\staging output -json | ConvertFrom-Json).azure_function_app_name.value

# Deploy
func azure functionapp publish $appName --build remote --javascript
```

#### Step 6: Deploy the Cloudflare Worker

```bash
cd c:\users\jonbr\source\repos\freedomtimes\web

npm install
npm run build

# Staging
npx wrangler deploy --config wrangler.jsonc --env staging

# Production
npx wrangler deploy --config wrangler.jsonc --env production
```

---

## Syncing Secrets & Variables

### Two Sync Paths

1. **Local → GitHub**: Prepare new credentials locally, sync to GitHub for CI/CD
2. **GitHub → Cloudflare**: GitHub Actions workflow auto-syncs after Terraform apply

---

### Local → GitHub Sync

Use `scripts/set-github-secrets.ps1` to push secrets and variables to GitHub Actions.

#### Prerequisites

1. **GitHub CLI authenticated:**
   ```bash
   gh auth login  # Interactive login
   ```

2. **.env.dev up-to-date** with all secrets and vars

#### Syncing Secrets to GitHub

```bash
.\scripts\set-github-secrets.ps1 `
  -Target Production `
  -SyncGitHubSecretsAndVars `
  -AllowProduction
```

**Secrets synced (from `.env.dev`):**
- `ARM_CLIENT_ID`
- `ARM_CLIENT_SECRET`
- `ARM_SUBSCRIPTION_ID`
- `ARM_TENANT_ID`
- `TF_VAR_CLOUDFLARE_API_TOKEN`
- `TF_VAR_CLOUDFLARE_ACCOUNT_ID`
- `TF_VAR_CLOUDFLARE_ZONE_ID`
- `TF_VAR_AUTH0_DOMAIN`
- `TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID`
- `TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET`
- `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING`
- `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_STAGING`
- `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION`
- `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_PRODUCTION`
- `AUTH0_LOGIN_APP_CLIENT_ID_STAGING`
- `AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING`
- `AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION`
- `AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION`

**Variables synced (from `.env.dev`):**
- `TF_VAR_AZURE_LOCATION`
- `API_UPSTREAM_MODE`
- `AUTH0_API_AUDIENCE`
- `AUTH0_API_AUDIENCE_STAGING`
- `COOKIE_BASE_DOMAIN`
- `AUTH0_ROLES_CLAIM_NAMESPACE`
- `TF_VAR_ROUTE_PATTERN_STAGING`
- `TF_VAR_ROUTE_PATTERN_PRODUCTION`
- `TF_VAR_WORKER_NAME_STAGING`
- `TF_VAR_WORKER_NAME_PRODUCTION`
- `TF_VAR_MANAGE_APEX_DNS_RECORD_STAGING`
- `TF_VAR_MANAGE_APEX_DNS_RECORD_PRODUCTION`
- `TF_VAR_APEX_DNS_RECORD_CONTENT_STAGING`
- `TF_VAR_APEX_DNS_RECORD_CONTENT_PRODUCTION`
- `TF_VAR_API_CUSTOM_HOSTNAME_STAGING`
- `TF_VAR_API_CUSTOM_HOSTNAME_PRODUCTION`
- `TF_VAR_WORKSPACE_URL_STAGING`
- `TF_VAR_WORKSPACE_URL_PRODUCTION`
- `TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS_STAGING`
- `TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS_PRODUCTION`

#### Dry Run (Preview)

```bash
.\scripts\set-github-secrets.ps1 `
  -Target Production `
  -SyncGitHubSecretsAndVars `
  -DryRun `
  -AllowProduction
```

---

## GitHub Actions Deployment Workflow

### Triggering Deployments

#### Staging: Automatic on Feature Branch Push

Staging deploys automatically when you push to `feat/11-editorial-api-cosmos`:

```bash
git checkout -b feature/my-feature
git push origin feature/my-feature
# Workflow: .github/workflows/terraform-staging.yml starts with plan-only
```

#### Staging: Manual Workflow Dispatch

```bash
gh workflow run terraform-staging.yml -f staging_terraform_apply=true
```

#### Production: GitHub Actions Manual Dispatch (Plan-Only by Default)

Push to `main` triggers workflow but only runs `terraform plan` by default (no apply):

```bash
git push origin main
# Workflow: .github/workflows/terraform-production.yml runs plan
```

To apply in production, dispatch manually **with apply enabled**:

```bash
gh workflow run terraform-production.yml -f production_terraform_apply=true
```

### Workflow Steps (Production Example)

1. **Checkout**: Pull repo code
2. **Setup Terraform**: Install TF 1.14.8
3. **Validate Environment**: Check all required secrets/vars present
4. **Preflight Unlock**: Unlock TF Cloud workspace if stale lock exists
5. **Terraform Init**: Initialize remote state
6. **Terraform Validate**: Check syntax
7. **Adopt Existing Resources**: Import manually-created APIM and Auth0 app (idempotent)
8. **Terraform Plan**: Generate execution plan
9. **Terraform Apply**: If `$PRODUCTION_TERRAFORM_APPLY == 'true'`, apply changes
10. **Re-proxy API CNAME**: After apply, flip CNAME to `proxied=true` for Cloudflare edge caching (2-pass pattern)
11. **Capture Outputs**: Retrieve Terraform outputs (Auth0 client ID, API URL, function app name)
12. **Fetch Auth0 App Secret**: Query Auth0 Management API for client secret
13. **Deploy Function App**: Deploy Node.js code to Azure Function App
14. **Build & Deploy Worker**: Build and deploy Astro Worker to Cloudflare
15. **Set Worker Secrets**: Sync Auth0 credentials to Cloudflare Worker
16. **Cleanup**: Unlock TF Cloud workspace

### 2-Pass CNAME Proxying (Important!)

**Problem:** Azure APIM custom domain registration requires a DNS lookup to verify ownership. If the CNAME is Cloudflare-proxied (orange cloud), Azure sees Cloudflare IPs and fails the ownership check.

**Solution:** Two-pass application:
1. **Pass 1 (main apply):** `api_custom_hostname_proxied = false`
   - CNAME is unproxied, Azure can verify ownership
   - Custom domain gets registered
2. **Pass 2 (re-proxy step):** Target-apply with `api_custom_hostname_proxied = true`
   - CNAME flipped to Cloudflare proxy
   - Terraform state updated
   - Worker now receives requests through Cloudflare edge

This is already configured in both `.github/workflows/terraform-staging.yml` and `terraform-production.yml`.

---

## Sync Script Reference

`scripts/set-github-secrets.ps1` is a lightweight wrapper for secret/variable management.

### Signature

```powershell
.\scripts\set-github-secrets.ps1 `
  [-Target <string>] `           # "Staging" or "Production"
  [-SyncCloudflareWorkerSecrets] # Push Auth0 creds to Cloudflare Worker
  [-SyncGitHubSecretsAndVars] `  # Push secrets/vars to GitHub Actions
  [-DryRun] `                    # Preview (no changes)
  [-AllowProduction]             # Safety flag required for production
```

### Examples

**Sync Cloudflare Worker secrets for staging:**
```bash
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets
```

**Sync GitHub secrets/vars for production (requires explicit approval):**
```bash
.\scripts\set-github-secrets.ps1 `
  -Target Production `
  -SyncGitHubSecretsAndVars `
  -AllowProduction
```

**Preview what would be synced (dry run):**
```bash
.\scripts\set-github-secrets.ps1 `
  -Target Production `
  -SyncGitHubSecretsAndVars `
  -DryRun `
  -AllowProduction
```

**Sync only staging secrets, keep GitHub out:**
```bash
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets -SyncGitHubSecretsAndVars
```

### What It Does

#### Cloudflare Worker Secrets (`-SyncCloudflareWorkerSecrets`)

Reads from local env and pushes to via `npx wrangler`:
```powershell
npx wrangler secret put AUTH0_DOMAIN --config wrangler.jsonc --env staging
npx wrangler secret put AUTH0_CLIENT_ID --config wrangler.jsonc --env staging
npx wrangler secret put AUTH0_CLIENT_SECRET --config wrangler.jsonc --env staging
```

#### GitHub Secrets & Variables (`-SyncGitHubSecretsAndVars`)

Uses `gh` CLI to create/update repository secrets and variables. Requires `-AllowProduction` flag for production to avoid accidental updates.

---

## Adding a New Environment

To add a new environment (e.g., "qa"):

### 1. Create Terraform Environment Directory

```bash
mkdir -p infra/terraform/environments/qa
cp infra/terraform/environments/staging/{main.tf,variables.tf,outputs.tf,versions.tf} infra/terraform/environments/qa/
```

### 2. Update Variable Defaults

Edit `infra/terraform/environments/qa/variables.tf`:

```hcl
variable "auth0_api_identifier" {
  description = "Auth0 API identifier (audience) for QA"
  type        = string
  default     = "https://api-qa.freedomtimes.news"
}

variable "workspace_url" {
  type    = string
  default = "https://qa.freedomtimes.news"
}

variable "api_custom_hostname" {
  type    = string
  default = "api-qa.freedomtimes.news"
}

# ... update route_pattern, worker_name, etc.
```

### 3. Create Environment Overlay Files

```bash
# .env.qa (local-only, not committed)
AUTH0_LOGIN_APP_CLIENT_ID_QA=<qa-auth0-client-id>
AUTH0_LOGIN_APP_CLIENT_SECRET_QA=<qa-auth0-client-secret>
```

### 4. Update terraform-run.ps1

Edit `scripts/terraform-run.ps1` to recognize the new environment:

```powershell
if ($Environment -eq "qa") {
    $envFilePath = ".env.qa"
    $audience_var = "AUTH0_API_AUDIENCE_QA"
    # ... rest of suffix logic
}
```

### 5. Create GitHub Actions Workflow

Copy `.github/workflows/terraform-staging.yml` to `.github/workflows/terraform-qa.yml` and update:

```yaml
name: Terraform - QA

on:
  push:
    branches: [feat/qa-branch]  # or your QA branch name
    # ...
  
env:
  QA_TERRAFORM_APPLY: "false"

jobs:
  terraform:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/terraform/environments/qa
    # ... update all TF_VAR references to QA-specific vars
```

### 6. Sync New Environment Secrets to GitHub

After creating `.env.qa` locally:

```bash
.\scripts\set-github-secrets.ps1 `
  -Target QA `
  -SyncGitHubSecretsAndVars
```

(Requires updating the script to handle the QA target first.)

---

## Local Development

### Setup: Pointing at Remote Backends

Local development typically uses staging or production backends:

#### Option 1: Staging Backend + Local Web App

Best for: Developing worker features without production impact

```bash
cd web

# Point to staging API
npx wrangler dev --config wrangler.jsonc --env staging
```

The worker will proxy to `https://api-staging.freedomtimes.news` (staging APIM).

Environment variables in `wrangler.jsonc` control routing:
```jsonc
{
  "env": {
    "staging": {
      "vars": {
        "API_BASE_URL": "https://api-staging.freedomtimes.news/editorial",
        "COOKIE_BASE_DOMAIN": "freedomtimes.news"
      }
    }
  }
}
```

#### Option 2: Production Backend + Local Web App

**Use with caution:** Modifies cookies/sessions in production!

```bash
cd web

# Point to production API
npx wrangler dev --config wrangler.jsonc --env production
```

### Setup: Local Backend

Development against a local editorial API (Function App running locally):

#### Prerequisites

1. **Azure Functions Core Tools:**
   ```bash
   brew tap azure/homebrew/azure-cli
   brew install azure-functions-core-tools@4
   ```

2. **Node.js 20+** and npm installed

#### Running Local Function App

```bash
cd functions/editorial-api

npm install
npm start  # Starts on http://localhost:7071/api/
```

Test locally:
```bash
curl http://localhost:7071/api/health
# {"ok":true,"stub":true,...}
```

#### Updating Worker Config for Local Backend

Edit `web/wrangler.jsonc` to add local environment:

```jsonc
{
  "env": {
    "local": {
      "vars": {
        "API_BASE_URL": "http://localhost:7071",
        "COOKIE_BASE_DOMAIN": "localhost",
        "AUTH0_API_AUDIENCE": "https://api-staging.freedomtimes.news"  // Still use staging Auth0
      }
    }
  }
}
```

Run worker pointing to local API:

```bash
cd web
npx wrangler dev --config wrangler.jsonc --env local
```

Worker runs on `http://localhost:8787`, proxies requests to `http://localhost:7071`.

#### Debugging Locally

Both worker and Function App should output logs to console:

**Function App logs:**
```
[7/6/2026 10:15:30 AM] Executing 'Functions.editorialHealth' (Reason='This function was programmatically called via the host APIs.', Id=...)
[7/6/2026 10:15:30 AM] editorialHealth ...
```

**Worker logs:**
```
[wrangler] Ready on http://localhost:8787
```

---

## `.env.dev` Example

### Complete Reference

Replace placeholder values with real secrets/credentials. **Never commit this file.**

See `.env.dev.example` in the repository for an up-to-date template.

**Template structure:**

```bash
# ============================================
# SHARED SECRETS (same for all environments)
# ============================================

# Azure
ARM_CLIENT_ID=<azure-sp-client-id>
ARM_CLIENT_SECRET=<azure-sp-secret>
ARM_SUBSCRIPTION_ID=<azure-subscription-id>
ARM_TENANT_ID=<azure-tenant-id>

# Cloudflare
TF_VAR_CLOUDFLARE_API_TOKEN=<cloudflare-api-token>
TF_VAR_CLOUDFLARE_ACCOUNT_ID=<cloudflare-account-id>
TF_VAR_CLOUDFLARE_ZONE_ID=<cloudflare-zone-id>

# Auth0 (Management API - same tenant for both environments)
TF_VAR_AUTH0_DOMAIN=freedomtimes.uk.auth0.com
TF_VAR_AUTH0_MANAGEMENT_CLIENT_ID=<auth0-mgmt-client-id>
TF_VAR_AUTH0_MANAGEMENT_CLIENT_SECRET=<auth0-mgmt-secret>

# ============================================
# ENVIRONMENT-SPECIFIC SECRETS
# ============================================

# STAGING
TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING=<base64-pfx-cert>
TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_STAGING=<pfx-password>
AUTH0_LOGIN_APP_CLIENT_ID_STAGING=<auth0-client-id>
AUTH0_LOGIN_APP_CLIENT_SECRET_STAGING=<auth0-client-secret>

# PRODUCTION
TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION=<base64-pfx-cert>
TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_PRODUCTION=<pfx-password>
AUTH0_LOGIN_APP_CLIENT_ID_PRODUCTION=<auth0-client-id>
AUTH0_LOGIN_APP_CLIENT_SECRET_PRODUCTION=<auth0-client-secret>

# ============================================
# SHARED VARIABLES (same for all environments)
# ============================================

TF_VAR_AZURE_LOCATION=uksouth
API_UPSTREAM_MODE=apim
AUTH0_API_AUDIENCE=https://api.freedomtimes.news
COOKIE_BASE_DOMAIN=freedomtimes.news
AUTH0_ROLES_CLAIM_NAMESPACE=https://freedomtimes.news/roles

# ============================================
# ENVIRONMENT-SPECIFIC VARIABLES
# ============================================

# STAGING
TF_VAR_ROUTE_PATTERN_STAGING=staging.freedomtimes.news/*
TF_VAR_WORKER_NAME_STAGING=freedomtimes-holding-staging
TF_VAR_MANAGE_APEX_DNS_RECORD_STAGING=false
TF_VAR_APEX_DNS_RECORD_CONTENT_STAGING=192.0.2.1
TF_VAR_API_CUSTOM_HOSTNAME_STAGING=api-staging.freedomtimes.news
TF_VAR_WORKSPACE_URL_STAGING=https://staging.freedomtimes.news
TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS_STAGING="https://staging.freedomtimes.news,https://freedomtimes.news"

# PRODUCTION
TF_VAR_ROUTE_PATTERN_PRODUCTION=freedomtimes.news/*
TF_VAR_WORKER_NAME_PRODUCTION=freedomtimes-holding
TF_VAR_MANAGE_APEX_DNS_RECORD_PRODUCTION=true
TF_VAR_APEX_DNS_RECORD_CONTENT_PRODUCTION=192.0.2.1
TF_VAR_API_CUSTOM_HOSTNAME_PRODUCTION=api.freedomtimes.news
TF_VAR_WORKSPACE_URL_PRODUCTION=https://freedomtimes.news
TF_VAR_API_MANAGEMENT_ALLOWED_ORIGINS_PRODUCTION="https://freedomtimes.news"
```

---

## Summary: Common Tasks

### I want to tear down staging and rebuild it locally

```bash
# 1. Delete Action Group
az monitor action-group delete --resource-group freedomtimes-staging-rg --name "Application Insights Smart Detection"

# 2. Destroy
.\scripts\terraform-run.ps1 -Environment staging -Operation destroy -LoadEnvFiles -AutoApprove

# 3. Re-init and apply
terraform -chdir=infra/terraform/environments/staging init
.\scripts\terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles

# 4. Sync secrets to Cloudflare
.\scripts\set-github-secrets.ps1 -Target Staging -SyncCloudflareWorkerSecrets

# 5. Deploy Function & Worker
cd functions/editorial-api && npm install
func azure functionapp publish freedomtimes-editorial-api-staging --build remote --javascript
cd ../../web && npm run build && npx wrangler deploy --env staging
```

### I want to deploy production via GitHub Actions

```bash
# 1. Ensure secrets synced to GitHub (one-time)
.\scripts\set-github-secrets.ps1 -Target Production -SyncGitHubSecretsAndVars -AllowProduction

# 2. Commit changes to main
git add .
git commit -m "Deploy production"
git push origin main

# 3. Dispatch workflow to apply
gh workflow run terraform-production.yml -f production_terraform_apply=true

# OR manually in GitHub UI:
# GitHub repo → Actions → Terraform - Production → Run workflow → production_terraform_apply=true
```

### I want to test with production backend locally

```bash
cd web
npx wrangler dev --config wrangler.jsonc --env production
# Opens http://localhost:8787
```

### I want to test with local Function App backend

```bash
# Terminal 1: Run Function App
cd functions/editorial-api
npm start  # http://localhost:7071

# Terminal 2: Run Worker pointing to local Function App
cd web
npx wrangler dev --config wrangler.jsonc --env local
# Opens http://localhost:8787, proxies to http://localhost:7071
```

