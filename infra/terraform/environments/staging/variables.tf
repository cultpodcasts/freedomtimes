variable "cloudflare_api_token" {
  description = "Cloudflare API token with permission to manage Workers and routes"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the site domain"
  type        = string
}

variable "azure_location" {
  description = "Azure region for editorial API resources"
  type        = string
  default     = "uksouth"
}

variable "emdash_database_url" {
  description = "External PostgreSQL connection string for EmDash in staging (for example Neon)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "enable_hyperdrive" {
  description = "Enable Cloudflare Hyperdrive for the EmDash staging database connection"
  type        = bool
  default     = false
}

variable "hyperdrive_name" {
  description = "Cloudflare Hyperdrive config name for EmDash staging"
  type        = string
  default     = "freedomtimes-emdash-staging"
}

variable "neon_api_key" {
  description = "Neon API key for Terraform-managed Neon resources"
  type        = string
  default     = ""
  sensitive   = true
}

variable "manage_neon_resources" {
  description = "Whether to manage existing Neon resources for EmDash in staging"
  type        = bool
  default     = false
}

variable "neon_project_id" {
  description = "Existing Neon project ID for staging EmDash"
  type        = string
  default     = ""
}

variable "neon_branch_id" {
  description = "Existing Neon branch ID for staging EmDash"
  type        = string
  default     = ""
}

variable "neon_endpoint_id" {
  description = "Existing Neon endpoint ID for staging EmDash"
  type        = string
  default     = ""
}

variable "neon_branch_name" {
  description = "Neon branch name for staging EmDash"
  type        = string
  default     = "production"
}

variable "neon_role_name" {
  description = "Neon role name for staging EmDash database owner"
  type        = string
  default     = "neondb_owner"
}

variable "neon_database_name" {
  description = "Neon database name for staging EmDash"
  type        = string
  default     = "neondb"
}

variable "enable_editorial_gateway_policy" {
  description = "Enable APIM gateway JWT/role policy for staging editorial API"
  type        = bool
  default     = true
}

variable "workspace_url" {
  description = "Workspace URL for staging auth callbacks"
  type        = string
  default     = "https://staging.freedomtimes.news"
}

variable "auth0_api_identifier" {
  description = "Auth0 API identifier (audience) for staging"
  type        = string
  default     = "https://api-staging.freedomtimes.news"
}

variable "apim_function_key" {
  description = "Optional APIM-to-Function host key injected in a follow-up apply"
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_management_allowed_origins" {
  description = "Allowed browser origins for staging APIM CORS policy"
  type        = list(string)
  default     = ["https://staging.freedomtimes.news", "https://freedomtimes.news"]
}

variable "editorial_roles_claim" {
  description = "JWT claim name that carries editorial roles"
  type        = string
  default     = "https://freedomtimes.news/roles"
}

variable "editorial_allowed_roles" {
  description = "Allowed roles for staging editorial API"
  type        = list(string)
  default     = ["admin", "editor"]
}

variable "api_management_publisher_name" {
  description = "Publisher name required by API Management"
  type        = string
  default     = "Freedom Times"
}

variable "api_management_publisher_email" {
  description = "Publisher email required by API Management"
  type        = string
  default     = "platform@freedomtimes.news"
}

variable "api_management_sku_name" {
  description = "API Management SKU name"
  type        = string
  default     = "Consumption_0"
}

variable "api_management_api_path" {
  description = "Public APIM path segment for editorial API"
  type        = string
  default     = "editorial"
}

variable "api_custom_hostname" {
  description = "Custom API hostname for staging APIM gateway"
  type        = string
  default     = "api-staging.freedomtimes.news"
}

variable "api_custom_hostname_proxied" {
  description = "Whether Cloudflare should proxy the staging API custom hostname CNAME"
  type        = bool
  default     = false
}

variable "api_custom_hostname_certificate_base64" {
  description = "Base64-encoded PFX certificate for staging custom API hostname"
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_custom_hostname_certificate_password" {
  description = "Certificate password for staging custom API hostname"
  type        = string
  default     = ""
  sensitive   = true
}

variable "worker_name" {
  description = "Worker name for the holding page"
  type        = string
  default     = "freedomtimes-holding-staging"
}

variable "route_pattern" {
  description = "Route pattern for the holding page worker"
  type        = string
}

variable "manage_apex_dns_record" {
  description = "Whether to create a proxied apex A record for custom-domain routing"
  type        = bool
  default     = false
}

variable "apex_dns_record_content" {
  description = "IPv4 value for apex A record when manage_apex_dns_record is enabled"
  type        = string
  default     = "192.0.2.1"
}

variable "holding_title" {
  description = "Holding page HTML title"
  type        = string
  default     = "Freedom Times (Staging)"
}

variable "holding_heading" {
  description = "Holding page heading"
  type        = string
  default     = "Freedom Times"
}

variable "holding_message" {
  description = "Holding page message"
  type        = string
  default     = "This is the staging environment."
}

variable "build_revision" {
  description = "Optional build revision shown on the holding page"
  type        = string
  default     = ""
}

variable "contact_email" {
  description = "Optional contact email shown on the holding page"
  type        = string
  default     = ""
}

variable "auth0_domain" {
  description = "Auth0 tenant domain (e.g., tenant.us.auth0.com)"
  type        = string
  sensitive   = true
}

variable "auth0_management_client_id" {
  description = "Auth0 Management API client ID (used by Terraform provider only, never output to app)"
  type        = string
  sensitive   = true
}

variable "auth0_management_client_secret" {
  description = "Auth0 Management API client secret (used by Terraform provider only, never output to app)"
  type        = string
  sensitive   = true
}
