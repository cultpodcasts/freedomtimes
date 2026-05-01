variable "auth0_domain" {
  description = "Auth0 tenant domain (e.g., freedomtimes.us.auth0.com)"
  type        = string
  sensitive   = true
}

variable "auth0_management_client_id" {
  description = "Auth0 Management API client ID (Terraform provider only)"
  type        = string
  sensitive   = true
}

variable "auth0_management_client_secret" {
  description = "Auth0 Management API client secret (Terraform provider only)"
  type        = string
  sensitive   = true
}

variable "auth0_api_identifier" {
  description = "Auth0 API audience identifier"
  type        = string
  default     = "https://api.freedomtimes.news"
}

variable "editorial_roles_claim" {
  description = "JWT claim carrying editorial roles"
  type        = string
  default     = "https://freedomtimes.news/roles"
}
