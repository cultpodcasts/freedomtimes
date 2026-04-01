variable "auth0_domain" {
  description = "Auth0 tenant domain"
  type        = string
}

variable "create_shared_resources" {
  description = "Whether to create tenant-wide resources (resource server, roles, action). Set false for non-production environments."
  type        = bool
  default     = true
}

variable "app_name" {
  description = "Auth0 application name"
  type        = string
  default     = "freedomtimes-admin"
}

variable "api_identifier" {
  description = "Auth0 API identifier (e.g., https://api.freedomtimes.news)"
  type        = string
  default     = "https://api.freedomtimes.news"
}

variable "workspace_url" {
  description = "Workspace URL for admin application callback"
  type        = string
  default     = "https://freedomtimes.news"
}

variable "extra_workspace_urls" {
  description = "Additional workspace base URLs to allow for callbacks/logout/origins (e.g., staging)"
  type        = list(string)
  default     = []
}

variable "auth0_action_client_id" {
  description = "Auth0 M2M app client ID for Actions (with read:users and read:roles scopes)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "auth0_action_client_secret" {
  description = "Auth0 M2M app client secret for Actions"
  type        = string
  sensitive   = true
  default     = ""
}
