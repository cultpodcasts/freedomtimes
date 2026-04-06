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
