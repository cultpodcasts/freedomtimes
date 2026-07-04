# Cloudflare API token for Terraform

Operator guide for the scoped Cloudflare API token used by Terraform in this repo — locally via `.env.dev` and remotely in HCP Terraform (Terraform Cloud) workspaces **`freedomtimes-staging`** and **`freedomtimes-production`**.

Terraform is the source of truth for Cloudflare resources listed below. Wrangler deploys Worker **bundle** content; Terraform owns script metadata, routes/custom domains, Worker secrets it manages, and Turnstile widgets.

See also: [README.md](./README.md), [web/docs/DEPLOY_TROUBLESHOOTING.md](../../web/docs/DEPLOY_TROUBLESHOOTING.md) (Wrangler + combined CI token notes).

## Where the token value lives

Use the **same token string** in all of these places (rotate together):

| Location | Variable name | Notes |
|----------|---------------|--------|
| Repo root `.env.dev` | `TF_VAR_CLOUDFLARE_API_TOKEN` | Loaded by `scripts/terraform-run.ps1 -LoadEnvFiles` |
| Shell (optional alias) | `CLOUDFLARE_API_TOKEN` | Wrangler reads this for non-interactive deploy / secret sync |
| HCP Terraform workspace **`freedomtimes-staging`** | `TF_VAR_cloudflare_api_token` (sensitive) | Must match local token used for staging apply |
| HCP Terraform workspace **`freedomtimes-production`** | `TF_VAR_cloudflare_api_token` (sensitive) | Must match local token used for production apply |
| GitHub Actions repo secret | `TF_VAR_CLOUDFLARE_API_TOKEN` | Synced from `.env.dev` via `set-github-secrets.ps1 -SyncGitHubSecretsAndVars` |

Non-secret Cloudflare IDs (also required for Terraform):

| Variable | Example source |
|----------|----------------|
| `TF_VAR_CLOUDFLARE_ACCOUNT_ID` / `TF_VAR_cloudflare_account_id` | Cloudflare dashboard → account sidebar |
| `TF_VAR_CLOUDFLARE_ZONE_ID` / `TF_VAR_cloudflare_zone_id` | `freedomtimes.news` zone → Overview → Zone ID |

## Permissions required today

These permissions match **active** `cloudflare_*` resources in `infra/terraform/` (staging, production, and `modules/cloudflare_holding_page`). Permission labels are exactly as shown in **My Profile → API Tokens → Create Token → Custom token**.

### Account permissions

| Dashboard permission | Access | Terraform resource(s) | Why |
|---------------------|--------|----------------------|-----|
| **Workers Scripts** | Edit | `cloudflare_workers_script`, `cloudflare_workers_secret` | Create/update Worker script shell; push secrets (`TURSO_*`, `TURNSTILE_*`, …) |
| **Turnstile** | Edit | `cloudflare_turnstile_widget.story_tips` | Create/manage Turnstile widgets for `/submit-a-tip` per environment |

`cloudflare_workers_domain` (staging custom domain binding) is managed through the Workers platform; **Workers Scripts → Edit** covers it in practice.

### Zone permissions

Scope zone resources to the **`freedomtimes.news`** zone only.

| Dashboard permission | Access | Terraform resource(s) | Why |
|---------------------|--------|----------------------|-----|
| **Workers Routes** | Edit | `cloudflare_workers_route` | Attach Worker to apex route pattern (production: `freedomtimes.news/*`) |
| **Zone** | Read | (provider) | Resolve zone ID and read zone metadata during plan/apply |
| **Workers Domains** | Edit | `cloudflare_workers_domain` | Bind Worker to custom hostname (staging: `staging.freedomtimes.news`) |

If **Workers Domains → Edit** is not offered separately in your account UI, **Workers Routes → Edit** on the zone is sufficient for staging custom-domain bindings in current stacks.

### Conditional (only if enabled in tfvars)

| Dashboard permission | Access | Terraform resource(s) | When |
|---------------------|--------|----------------------|------|
| **DNS** | Edit | `cloudflare_record.apex` | `manage_apex_dns_record = true` in environment tfvars |

`cloudflare_record` for Azure APIM custom hostnames in `main.tf` is **commented out** — do not add DNS Edit unless that block is re-enabled.

### Not required for Terraform-only apply

These are **not** used by current Terraform Cloudflare resources but are often needed on the **same** token in CI because GitHub Actions also runs Wrangler deploy:

| Permission | Used by |
|------------|---------|
| **Workers KV Storage → Edit** | Wrangler deploy (staging `SESSION` KV binding); error `10023` if missing |
| **Workers R2 Storage → Edit** | Wrangler deploy when R2 bindings change (media bucket) |

Details: [scripts/set-github-secrets.md § Cloudflare Token Permissions (CI)](../../scripts/set-github-secrets.md#cloudflare-token-permissions-ci).

## Token scope (account + zone)

On the **Create Custom Token** form:

1. **Account resources** → Include → select the Freedom Times account (e.g. account ID `bae3f835f19899c6eee1ec48f2d658cf`).
2. **Zone resources** → Include → Specific zone → **`freedomtimes.news`**.

Do not use “All zones” or “All accounts” unless you have a deliberate reason.

## Dashboard walkthrough

1. Log in to [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Open **My Profile** (avatar, top right) → **API Tokens**.
3. Click **Create Token**.
4. Choose **Create Custom Token** (not a template — templates may omit Turnstile).
5. **Token name:** e.g. `freedomtimes-terraform`.
6. **Permissions** — add rows as in the tables above:
   - Account → **Workers Scripts** → **Edit**
   - Account → **Turnstile** → **Edit**
   - Zone → **Workers Routes** → **Edit** (zone: `freedomtimes.news`)
   - Zone → **Zone** → **Read** (zone: `freedomtimes.news`)
   - Zone → **Workers Domains** → **Edit** (zone: `freedomtimes.news`) — if available
   - (Optional) Zone → **DNS** → **Edit** — only if `manage_apex_dns_record` is true
7. **Account resources** → Include → your Freedom Times account.
8. **Zone resources** → Include → Specific zone → `freedomtimes.news`.
9. **Client IP address filtering** — optional; leave unrestricted unless your ops model requires it.
10. **TTL** — optional expiry; set a calendar reminder to rotate before expiry.
11. Click **Continue to summary** → **Create Token**.
12. Copy the token once (shown only at creation). Store in `.env.dev` as `TF_VAR_CLOUDFLARE_API_TOKEN=...`.

### Sync to HCP Terraform

For each workspace (`freedomtimes-staging`, `freedomtimes-production`):

1. HCP Terraform → organization **freedomtimes** → workspace → **Variables**.
2. Add or update **Environment variable** (sensitive):
   - Key: `TF_VAR_cloudflare_api_token`
   - Value: same token string as `.env.dev`
3. Ensure `TF_VAR_cloudflare_account_id` and `TF_VAR_cloudflare_zone_id` are set (non-sensitive is fine).

### Sync to GitHub (CI)

```powershell
pwsh scripts/set-github-secrets.ps1 -SyncGitHubSecretsAndVars -AllowProduction
```

Requires `gh` auth and `-AllowProduction` because repo secrets affect production workflows.

## Verify the token

Local Terraform preflight (loads `.env.dev`):

```powershell
pwsh scripts/terraform-preflight.ps1 -Environment staging -LoadEnvFiles
```

Wrangler (uses `CLOUDFLARE_API_TOKEN` if set):

```powershell
$env:CLOUDFLARE_API_TOKEN = "<same-token>"
$env:CLOUDFLARE_ACCOUNT_ID = "<account-id>"
npx wrangler whoami
```

Staging plan (should not return `Authentication error (10000)` on Turnstile):

```powershell
pwsh scripts/terraform-run.ps1 -Environment staging -Operation plan -LoadEnvFiles
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Authentication error (10000)` creating `cloudflare_turnstile_widget` | Token missing **Turnstile → Edit** | Add permission; update `.env.dev` + TFC workspace var; re-apply |
| `Authentication error (10000)` on Worker script/secret | Missing **Workers Scripts → Edit** | Same |
| Route/custom domain failures | Missing **Workers Routes** or **Workers Domains → Edit** on zone | Add zone permission; re-apply |
| Wrangler deploy `10023` (KV) | Token OK for Terraform but not Wrangler | Add **Workers KV Storage → Edit** (CI token) |
| Plan OK locally, apply fails in TFC | Stale token in workspace variable only | Update `TF_VAR_cloudflare_api_token` in **both** workspaces |

## When Terraform Cloudflare resources change

If you add new `cloudflare_*` resources (DNS records, R2 buckets, Access, etc.), update this document **before** expanding the token. Grep the repo:

```powershell
rg 'resource "cloudflare_' infra/terraform
```

Then adjust the token and link from [README.md](./README.md).
