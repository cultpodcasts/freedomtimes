# Local Development Requirements

This is a living checklist for setting up and validating local development for Freedom Times.

## Core Tools

- Git
- GitHub CLI (`gh`) with access to this repository
- Terraform CLI (for IaC deployment workflows)
- A code editor (VS Code recommended)

## Verified in This Workspace

- Terraform: `v1.14.8` (`terraform -version`)

## GitHub Access

- Authenticate with an account that has repository, PR, and project board access:
  - `gh auth login -h github.com`
  - `gh auth status`
- Required scopes as of now:
  - `repo`
  - `read:org`
  - `project` (includes read/write project operations)

## Terraform Workflow (Current)

Note: local application development does not need Terraform. Use Terraform when planning/applying managed infrastructure for production or staging.

Terraform structure currently exists at:
- `infra/terraform/modules/cloudflare_holding_page`
- `infra/terraform/environments/production`
- `infra/terraform/environments/staging`

For infrastructure planning/apply:

1. Change directory:
   - production: `cd infra/terraform/environments/production`
   - staging: `cd infra/terraform/environments/staging`
2. Use `terraform.tfvars.example` as a placeholder template only (do not place real secrets in examples)
3. Set required variables in shell (PowerShell):
   - `$env:TF_VAR_cloudflare_api_token = "<token>"`
   - `$env:TF_VAR_cloudflare_account_id = "<account-id>"`
   - `$env:TF_VAR_cloudflare_zone_id = "<zone-id>"`
   - `$env:TF_VAR_route_pattern = "example.com/*"`
4. Run Terraform:
   - `terraform init`
   - `terraform plan`
   - `terraform apply`

Local automation helpers (recommended):

- Validate environment and provider credentials:
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-preflight.ps1 -Environment staging -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-preflight.ps1 -Environment production -LoadEnvFiles`
- Run Terraform non-interactively:
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation init -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation plan -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation destroy -LoadEnvFiles -AutoApprove`

Notes:

- `terraform-run.ps1` uses `-input=false` and lock timeout flags automatically.
- `apply` uses `tfplan` when present; otherwise pass `-AutoApprove` for direct apply.
- `destroy` requires `-AutoApprove` to avoid interactive prompts.

## Security Rules

- Do not store secrets in tfvars files.
- Keep `terraform.tfvars.example` files placeholder-only; never put actual environment values in examples.
- Never hardcode API tokens in `.tf` files or docs.
- Use least-privilege Cloudflare tokens.

## Cloudflare Token Permissions (Track This)

Current required permissions for `TF_VAR_cloudflare_api_token`:

- Account: `Workers Scripts: Edit`
- Zone: `Workers Routes: Edit`
- Zone: `Zone: Read`

Scope the token to the specific Freedom Times account and zone only.

If Terraform resources change later (for example DNS records, KV namespace management, cache operations), update this section before expanding token permissions.

## Next Items to Add Here

- Node.js and package manager version requirements (once app code is added)
- Wrangler CLI requirement and version
- Auth0 local integration requirements
- Any required VS Code extensions
- CI parity commands for local preflight checks
