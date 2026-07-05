variable "auth0_domain" {
  description = "Auth0 tenant domain (e.g., tenant.us.auth0.com)"
  type        = string
  sensitive   = true
}

variable "auth0_management_client_id" {
  description = "Auth0 Management API client ID (used by Terraform provider only)"
  type        = string
  sensitive   = true
}

variable "auth0_management_client_secret" {
  description = "Auth0 Management API client secret (used by Terraform provider only)"
  type        = string
  sensitive   = true
}

variable "auth0_api_identifier" {
  description = "Shared Auth0 API identifier (audience)"
  type        = string
  default     = "https://api.freedomtimes.news"
}

variable "editorial_roles_claim" {
  description = "JWT claim name that carries editorial roles"
  type        = string
  default     = "https://freedomtimes.news/roles"
}

variable "workspace_url" {
  description = "Placeholder URL required by module input; login app is disabled in this environment"
  type        = string
  default     = "https://freedomtimes.news"
}

# --- Tenant-wide session lifetime (re-sign-in interval) --------------------
# Auth0 session_lifetime/idle_session_lifetime are tenant-level settings (not per-application),
# so they live here rather than in modules/auth0_app. This governs the Auth0-side SSO session
# used when a user is silently redirected back through /authorize (e.g. after the app's own
# ft_session cookie/ID token expires) — see web/docs/AUTH.md "Session lifetime (Terraform)".
#
# IMPORTANT: auth0_tenant is a tenant singleton. Before the first apply that introduces this
# resource, import the existing tenant so unrelated tenant settings (friendly_name, flags,
# support_email, etc.) are not reset to provider defaults:
#   pwsh scripts/terraform-run.ps1 -Environment auth0-shared -Operation import -LoadEnvFiles `
#     -ImportAddress auth0_tenant.main -ImportId <any-placeholder-id>
# (auth0_tenant import is ID-passthrough; the value itself is not read back from Auth0.)
# See web/docs/AUTH.md "Session lifetime (Terraform)" for the full apply walkthrough.

variable "manage_tenant_session_lifetime" {
  description = "Whether this environment manages tenant-wide Auth0 session lifetime settings (auth0_tenant.session_lifetime / idle_session_lifetime). Set false to leave tenant session settings entirely unmanaged by Terraform."
  type        = bool
  default     = false
}

variable "tenant_session_lifetime_hours" {
  description = "Auth0 tenant session_lifetime in hours: absolute maximum duration of the Auth0 SSO session, even if the user stays active. Auth0 default for new tenants is 168 (7 days)."
  type        = number
  default     = 336 # 14 days
}

variable "tenant_idle_session_lifetime_hours" {
  description = "Auth0 tenant idle_session_lifetime in hours: how long the Auth0 SSO session can be inactive before the user must fully log in again. Auth0 default for new tenants is 72 (3 days)."
  type        = number
  default     = 168 # 7 days
}
