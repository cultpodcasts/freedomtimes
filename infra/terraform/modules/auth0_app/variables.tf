variable "auth0_domain" {
  description = "Auth0 tenant domain"
  type        = string
}

variable "create_shared_resources" {
  description = "Whether to create tenant-wide resources (resource server, roles, action). Set false for non-production environments."
  type        = bool
  default     = true
}

variable "create_api_resource_server" {
  description = "Whether to create the Auth0 API resource server and scopes for this audience."
  type        = bool
  default     = false
}

variable "create_login_app" {
  description = "Whether to create the Auth0 regular web application and credentials."
  type        = bool
  default     = true
}

variable "app_name" {
  description = "Auth0 application name"
  type        = string
  default     = "freedomtimes-admin"
}

variable "api_identifier" {
  description = "Auth0 API identifier (audience)"
  type        = string
}

variable "api_name" {
  description = "Auth0 API resource server name"
  type        = string
  default     = "freedomtimes-api"
}

variable "workspace_url" {
  description = "Workspace URL for admin application callback"
  type        = string
}

variable "roles_claim_namespace" {
  description = "Namespace prefix for custom role claims (without /roles suffix)"
  type        = string
}

variable "extra_workspace_urls" {
  description = "Additional workspace base URLs to allow for callbacks/logout/origins (e.g., staging)"
  type        = list(string)
  default     = []
}

variable "extra_callback_urls" {
  description = "Additional callback URLs to allow beyond workspace_url/auth/callback patterns, such as native mobile deep links"
  type        = list(string)
  default     = []
}

variable "jwt_signing_alg" {
  description = "JWT signing algorithm for Auth0 application tokens"
  type        = string
  default     = "HS256"
}

variable "enable_machine_to_machine_grant" {
  description = "Enable client_credentials grant type for the login app so it can request M2M tokens for the API audience"
  type        = bool
  default     = false
}

# --- Session / re-sign-in interval settings -------------------------------
# See web/docs/AUTH.md "Session lifetime (Terraform)" for how these map to the
# app's ft_session cookie and verifyIdToken() exp check.

variable "id_token_lifetime_in_seconds" {
  description = "ID token lifetime (seconds) for the login app client (jwt_configuration.lifetime_in_seconds). Governs how long the ft_session cookie's token stays valid before verifyIdToken requires a silent refresh (or a fresh Auth0 login). Matches SESSION_COOKIE_MAX_AGE_SECONDS in web/src/lib/auth.ts."
  type        = number
  default     = 86400 # 24 hours - matches ft_session/ft_csrf cookie maxAge (60*60*24) in web/src/lib/auth.ts
}

variable "enable_refresh_token_rotation" {
  description = "Configure a rotating, expiring refresh_token policy on the login app client. The web app requests offline_access and uses silent refresh in editorial-session.ts — see web/docs/AUTH.md."
  type        = bool
  default     = true
}

variable "refresh_token_lifetime_seconds" {
  description = "Absolute refresh token lifetime in seconds (refresh_token.token_lifetime). Only applied when enable_refresh_token_rotation is true."
  type        = number
  default     = 2592000 # 30 days
}

variable "refresh_token_idle_lifetime_seconds" {
  description = "Idle (inactive) refresh token lifetime in seconds (refresh_token.idle_token_lifetime). Only applied when enable_refresh_token_rotation is true."
  type        = number
  default     = 1209600 # 14 days
}

variable "refresh_token_leeway" {
  description = "Grace period in seconds during which a rotated refresh token may still be reused (refresh_token.leeway), to tolerate client retries/race conditions."
  type        = number
  default     = 10
}
