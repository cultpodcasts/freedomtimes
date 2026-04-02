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

## API Auth Topology

The intended topology for editorial API requests is:

1. Browser sends HttpOnly auth cookie to APIM host (subdomain under the same parent domain).
2. APIM policy extracts JWT from cookie and sets upstream `Authorization` header.
3. APIM validates JWT audience and role claims.
4. Azure Function EasyAuth validates the forwarded bearer token.

This combines gateway policy control with EasyAuth defense in depth while avoiding JS-readable access tokens in the browser.

Operational notes:

- APIM CORS must be configured for credentialed requests with explicit origins.
- APIM policy should sanitize inbound auth headers and only trust cookie-derived token input.
- Keep EasyAuth enabled unless Function ingress is otherwise strongly restricted.

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

Important for this repository:

- Do not use `terraform init -backend-config=...` in these environment folders.
- These folders use the `terraform { cloud { ... } }` block, so workspace selection is already defined in `versions.tf`.

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

## Runbook: Cookie To APIM To EasyAuth

This runbook captures the target flow where browser requests carry an HttpOnly cookie, APIM converts cookie token to bearer header, APIM validates roles, and EasyAuth performs a second validation at the Function boundary.

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

## Observability: Application Insights + Correlation ID

Editorial API infrastructure now includes:

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
