# Terraform Infrastructure

Terraform baseline for Freedom Times infrastructure.

Terraform is not required for local application development. Local work can run with non-Terraform tooling (for example, Wrangler/app runtime). Terraform is the source of truth for managed environment deployment.

## Current Scope

- Cloudflare holding page worker
- Worker route attachment to a configured zone pattern
- Auth0 application and RBAC resources
- Azure editorial API foundation (Resource Group, Function App, Cosmos DB)
- Azure Function EasyAuth with Auth0 OIDC
- Azure API Management gateway policy for JWT validation and role claim enforcement
- Environment entrypoints for `production` and `staging`

## Environment Separation Rule

Terraform must maintain strict separation between staging and production for all providers (Cloudflare, Auth0, Azure).

- Use separate environment entrypoints:
   - `environments/staging`
   - `environments/production`
- Keep distinct Terraform Cloud workspaces per environment.
- Keep environment-specific resource names and settings so staging and production do not collide.
- Do not deploy feature work directly to production first; staging remains the validation path before production promotion.

## Layout

- environments/production: production environment entrypoint and variables
- environments/staging: staging environment entrypoint and variables
- modules/cloudflare_holding_page: reusable module for holding page worker and route
- modules/auth0_app: reusable module for Auth0 app and shared auth resources
- modules/azure_editorial_api: reusable module for Azure editorial API resources

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
2. (Optional) copy values from `terraform.tfvars.example` as non-secret defaults only
3. Export required variables in shell (PowerShell):
   - `$env:TF_VAR_cloudflare_api_token = "<token>"`
   - `$env:TF_VAR_cloudflare_account_id = "<account-id>"`
   - `$env:TF_VAR_cloudflare_zone_id = "<zone-id>"`
   - `$env:TF_VAR_route_pattern = "example.com/*"`
4. Run:
   - terraform init
   - terraform plan
   - terraform apply

Recommended route examples:
- production: `example.com/*`
- staging: `staging.freedomtimes.news/*`

## Delivery Plan Note

- Current objective is production deployment of a holding page from GitHub Actions.
- Staging is scaffolded and supported in Terraform, but a separate ticket will cover staging deployment once functionality exists to place behind Auth0.
- Local development remains separate from Terraform deployment workflows.

## Notes

- This is intentionally minimal for first deployment of a holding page.
- Next steps can add remote state backend, staging/prod environments, and additional Cloudflare resources under IaC.
