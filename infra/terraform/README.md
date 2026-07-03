# Terraform Infrastructure

Terraform baseline for Freedom Times infrastructure.

Terraform is not required for local application development. Local work can run with non-Terraform tooling (for example, Wrangler/app runtime). Terraform is the source of truth for managed environment deployment.

## Current Scope

- Cloudflare holding page worker
- Worker route attachment to a configured zone pattern
- Auth0 application and RBAC resources
- Turso databases for EmDash, scheduler, push subscriptions, and reader tips
- Environment entrypoints for `production` and `staging`

## Environment Separation Rule

Terraform must maintain strict separation between staging and production for all providers (Cloudflare, Auth0, Turso).

- Use separate environment entrypoints:
   - `environments/staging`
   - `environments/production`
   - `environments/auth0-shared`
- Keep distinct Terraform Cloud workspaces per environment.
- Keep environment-specific resource names and settings so staging and production do not collide.
- Do not deploy feature work directly to production first; staging remains the validation path before production promotion.

Auth0 shared ownership rule:

- Tenant-wide Auth0 resources (API resource server, roles, role permissions, post-login action binding) are owned by `environments/auth0-shared`.
- Staging and production each manage only their own login application resources.

## Layout

- environments/production: production environment entrypoint and variables
- environments/staging: staging environment entrypoint and variables
- environments/auth0-shared: tenant-shared Auth0 entrypoint and variables
- modules/cloudflare_holding_page: reusable module for holding page worker and route
- modules/auth0_app: reusable module for Auth0 app and shared auth resources

## Security

- Do not use tfvars files for secrets
- Keep `terraform.tfvars.example` files in repo as templates with placeholder values only
- Pass Cloudflare API token through environment variable or CI secret
- Use least-privilege Cloudflare API tokens

### Cloudflare API Token (Least Privilege)

For the current Terraform stack (Worker script + Worker route), create a token with only:

- **Account permissions**
   - `Workers Scripts: Edit`
- **Zone permissions**
   - `Workers Routes: Edit`
   - `Zone: Read`

Scope the token to:

- the single Cloudflare account used for Freedom Times
- the single production zone (domain)

Do not grant unrelated permissions (DNS edit, cache purge, account settings, billing, etc.) unless a later Terraform resource explicitly requires them.

## Local Usage

1. Choose an environment directory:
   - `environments/production`
   - `environments/staging`
2. Ensure HCP Terraform token is exported:
   - `$env:TF_TOKEN_app_terraform_io = "<terraform-cloud-user-token>"`
3. (Optional) copy values from `terraform.tfvars.example` as non-secret defaults only
4. Export required variables in shell (PowerShell):
   - `$env:TF_VAR_cloudflare_api_token = "<token>"`
   - `$env:TF_VAR_cloudflare_account_id = "<account-id>"`
   - `$env:TF_VAR_cloudflare_zone_id = "<zone-id>"`
   - `$env:TF_VAR_route_pattern = "example.com/*"`
5. Run:
   - terraform init
   - terraform plan
   - terraform apply

Recommended non-interactive forms:
- terraform init -input=false
- terraform plan -input=false -lock-timeout=5m -no-color
- terraform apply -input=false -lock-timeout=5m -no-color
- terraform destroy -input=false -lock-timeout=5m -no-color -auto-approve

Important for this repository:

- Do not use `terraform init -backend-config=...` in these environment folders.
- These folders use the `terraform { cloud { ... } }` block, so workspace selection is already defined in `versions.tf`.

## Troubleshooting

### Provider auth failures

- Auth0 provider: set `TF_VAR_auth0_domain`, `TF_VAR_auth0_management_client_id`, and `TF_VAR_auth0_management_client_secret`.
- Cloudflare provider: set `TF_VAR_cloudflare_api_token`, `TF_VAR_cloudflare_account_id`, and `TF_VAR_cloudflare_zone_id`.
- Turso provider: set `TF_VAR_turso_api_token` and `TF_VAR_turso_organization`.
- Terraform Cloud auth: set shell env `TF_TOKEN_app_terraform_io`, or in GitHub use secret `TF_TOKEN_APP_TERRAFORM_IO`.

### Workspace lock errors

If plan/apply reports that the workspace is already locked:

1. Confirm no active apply is running in HCP Terraform.
2. Unlock explicitly (replace ID from error output):
   - `terraform force-unlock -force <LOCK_ID>`
3. Re-run with lock retry:
   - `terraform plan -input=false -lock-timeout=5m -no-color`

### Avoid manual prompts

- Always pass `-input=false` for CI and scripted local runs.
- For destroy automation, use `-auto-approve` only in controlled contexts.
- Keep secrets out of `*.tfvars`; use environment variables or CI secret stores.

Recommended route examples:
- production: `example.com/*`
- staging: `staging.freedomtimes.news/*`

## Delivery Plan Note

- Current objective is production deployment of a holding page from GitHub Actions.
- Staging is scaffolded and supported in Terraform, but a separate ticket will cover staging deployment once functionality exists to place behind Auth0.
- Local development remains separate from Terraform deployment workflows.

## Notes

- This is intentionally minimal for first deployment of a holding page.
- Next steps can add additional Cloudflare resources (R2 buckets, extra Worker routes) under IaC as needed.

## Related documentation

- `ARCHITECTURE.md` — platform stack, EmDash CMS, Auth0 same-origin auth, deployment pipeline
- `NON_TERRAFORM_RESOURCES.md` — one-time Auth0 bootstrap before first `terraform apply`
