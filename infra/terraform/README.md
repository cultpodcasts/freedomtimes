# Terraform Infrastructure

Terraform baseline for Freedom Times infrastructure.

Terraform is not required for local application development. Local work can run with non-Terraform tooling (for example, Wrangler/app runtime). Terraform is the source of truth for managed environment deployment.

## Current Scope

- Cloudflare holding page worker
- Worker route attachment to a configured zone pattern
- Auth0 application and RBAC resources
- Turso database resources used by EmDash
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
- Next steps can add remote state backend, staging/prod environments, and additional Cloudflare resources under IaC.

## Azure editorial API runbooks (not in active use)

> **Status:** Archived reference only. Freedom Times **does not deploy or use** Azure resources, APIM, Easy Auth, or the Function App editorial API described below. The live stack is Cloudflare Workers + EmDash + Turso + R2 with same-origin Auth0 cookies (`ARCHITECTURE.md` §4.11). These runbooks remain in-repo for historical Terraform/module context and incident archaeology — do not follow them for current deployments. See `NON_TERRAFORM_RESOURCES.md` for active bootstrap rules.

## Runbook: Cookie To APIM To EasyAuth

This runbook captures the **former** target flow where browser requests carry an HttpOnly cookie, APIM converts cookie token to bearer header, APIM validates roles, and EasyAuth performs a second validation at the Function boundary.

### 1. APIM policy skeleton

Use policy logic that:

- reads token from a dedicated cookie name
- rejects missing token with `401`
- replaces any client-supplied `Authorization` header
- validates JWT audience and role claim

Example (conceptual policy fragment):

```xml
<inbound>
   <base />

   <cors allow-credentials="true">
      <allowed-origins>
         <origin>https://staging.freedomtimes.news</origin>
         <origin>https://freedomtimes.news</origin>
      </allowed-origins>
      <allowed-methods>
         <method>GET</method>
         <method>POST</method>
         <method>PUT</method>
         <method>PATCH</method>
         <method>DELETE</method>
         <method>OPTIONS</method>
      </allowed-methods>
      <allowed-headers>
         <header>Content-Type</header>
         <header>X-CSRF-Token</header>
      </allowed-headers>
   </cors>

   <set-variable name="jwtCookie" value="@{
      var cookie = context.Request.Headers.GetValueOrDefault("Cookie", "");
      var marker = "ft_api_token=";
      var start = cookie.IndexOf(marker, StringComparison.Ordinal);
      if (start < 0) return "";
      start += marker.Length;
      var end = cookie.IndexOf(";", start, StringComparison.Ordinal);
      return (end < 0 ? cookie.Substring(start) : cookie.Substring(start, end - start)).Trim();
   }" />

   <choose>
      <when condition="@(!string.IsNullOrEmpty((string)context.Variables["jwtCookie"]))">
         <set-header name="Authorization" exists-action="override">
            <value>@($"Bearer {(string)context.Variables["jwtCookie"]}")</value>
         </set-header>
      </when>
      <otherwise>
         <return-response>
            <set-status code="401" reason="Unauthorized" />
         </return-response>
      </otherwise>
   </choose>

   <validate-jwt header-name="Authorization" require-scheme="Bearer">
      <openid-config url="https://freedomtimes.uk.auth0.com/.well-known/openid-configuration" />
      <audiences>
         <audience>https://api.freedomtimes.news</audience>
      </audiences>
      <required-claims>
         <claim name="https://freedomtimes.news/roles" match="any">
            <value>admin</value>
            <value>editor</value>
         </claim>
      </required-claims>
   </validate-jwt>
</inbound>
```

### 2. Cookie settings matrix

Use separate cookie names per environment and explicit settings:

| Setting | Staging | Production |
|---|---|---|
| Cookie name | `ft_api_token_stg` | `ft_api_token` |
| Domain | `.freedomtimes.news` | `.freedomtimes.news` |
| Path | `/` | `/` |
| HttpOnly | `true` | `true` |
| Secure | `true` | `true` |
| SameSite | `Lax` | `Lax` |
| Max-Age | 15-30 min | 15-30 min |

Notes:

- Separate names reduce accidental cross-environment collisions.
- `SameSite=Lax` generally works for same-site subdomain requests. Re-evaluate if request patterns change.

### 3. Frontend request requirements

Browser fetches to APIM host must include credentials:

```ts
await fetch("https://api-staging.freedomtimes.news/editorial/stories", {
   method: "GET",
   credentials: "include",
});
```

Do not attach bearer tokens from JavaScript when using this model.

### 4. CSRF baseline

Because auth is cookie-based, apply CSRF controls for state-changing routes:

- Require `X-CSRF-Token` for `POST/PUT/PATCH/DELETE`.
- Validate token server-side against per-session value.
- Reject missing or invalid tokens with `403`.

### 5. EasyAuth expectations

EasyAuth continues to validate the forwarded bearer token from APIM.

- Keep `require_authentication=true`.
- Keep direct Function URL non-public wherever possible.
- Treat APIM as policy and role gate; EasyAuth as second auth gate.

### 6. Custom API hostnames

Configured hostnames:

- Staging: `api-staging.freedomtimes.news`
- Production: `api.freedomtimes.news`

Terraform wiring now supports APIM gateway custom domains plus Cloudflare DNS records. To enable each hostname, provide:

- `api_custom_hostname_certificate_base64` (base64-encoded PFX)
- `api_custom_hostname_certificate_password`

Suggested GitHub Actions secrets:

- Staging: `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING`
- Staging: `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_STAGING`
- Production: `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION`
- Production: `TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_PRODUCTION`

Example setup commands (PowerShell, from repo root):

```powershell
# Staging certificate
$stgPfxBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\api-staging.freedomtimes.news.pfx"))
$stgPfxPassword = "<staging-pfx-password>"
gh secret set TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_STAGING --repo cultpodcasts/freedomtimes --body "$stgPfxBase64"
gh secret set TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_STAGING --repo cultpodcasts/freedomtimes --body "$stgPfxPassword"

# Production certificate
$prodPfxBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\api.freedomtimes.news.pfx"))
$prodPfxPassword = "<production-pfx-password>"
gh secret set TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_BASE64_PRODUCTION --repo cultpodcasts/freedomtimes --body "$prodPfxBase64"
gh secret set TF_VAR_API_CUSTOM_HOSTNAME_CERTIFICATE_PASSWORD_PRODUCTION --repo cultpodcasts/freedomtimes --body "$prodPfxPassword"
```

When certificate inputs are not provided, Terraform keeps the default APIM hostname and does not create the custom API DNS record.

Certificate handling safety rules:

- Never commit certificate/key files (`.pfx`, `.pem`, `.key`, `.crt`, etc.) to the repository.
- Never upload certificate material as GitHub Actions artifacts.
- Keep certificate material only in GitHub Secrets (or equivalent secret store).
- Terraform plan files (`tfplan`) may contain sensitive values; CI should delete them after use.

## Observability: Application Insights + Correlation ID (not in active use)

The following described **former** Azure editorial API infrastructure:

- Log Analytics workspace
- Workspace-based Application Insights
- APIM API diagnostics configured to send telemetry to Application Insights

Correlation ID behavior at APIM:

- Accepts incoming `X-Correlation-ID` from client when present
- Generates one from APIM request id when missing
- Forwards `X-Correlation-ID` to backend
- Echoes `X-Correlation-ID` on outbound and error responses

This enables end-to-end request tracing from browser to APIM and backend telemetry.

### Query by correlation id (KQL)

In Application Insights, use a query like:

```kusto
let cid = "<correlation-id-from-response-header>";
union isfuzzy=true requests, traces, exceptions, dependencies
| where tostring(customDimensions["x-correlation-id"]) == cid
   or operation_Id == cid
   or tostring(customDimensions["CorrelationId"]) == cid
| project timestamp, itemType, operation_Id, cloud_RoleName, name, resultCode, message, customDimensions
| order by timestamp asc
```

For APIM request diagnostics specifically:

```kusto
let cid = "<correlation-id-from-response-header>";
requests
| where cloud_RoleName has "apim" or name has "/editorial/"
| where tostring(customDimensions["x-correlation-id"]) == cid or operation_Id == cid
| project timestamp, name, resultCode, duration, operation_Id, customDimensions
| order by timestamp asc
```
