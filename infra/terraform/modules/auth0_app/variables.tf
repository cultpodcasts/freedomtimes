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

variable "jwt_signing_alg" {
  description = "JWT signing algorithm for Auth0 application tokens"
  type        = string
  default     = "HS256"
}
