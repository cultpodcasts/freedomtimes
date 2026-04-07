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

variable "turso_api_token" {
  description = "Turso API token used by Terraform to manage production EmDash resources"
  type        = string
  default     = ""
  sensitive   = true
}

variable "turso_organization" {
  description = "Turso organization or user slug for production EmDash resources"
  type        = string
}

variable "turso_database_name" {
  description = "Turso database name for production EmDash"
  type        = string
  default     = "freedomtimes-emdash-production"
}

variable "turso_database_group" {
  description = "Optional Turso group for production EmDash database"
  type        = string
  default     = ""
}

variable "turso_database_token_expiration" {
  description = "Optional expiration for the production EmDash database token (for example 90d or 2w1d30m). Leave empty for no explicit expiration."
  type        = string
  default     = ""
}

variable "turso_database_size_limit" {
  description = "Optional size limit for the production EmDash database"
  type        = string
  default     = ""
}

variable "turso_database_delete_protection" {
  description = "Whether delete protection should be enabled for the production EmDash database"
  type        = bool
  default     = true
}

variable "turso_database_token_authorization" {
  description = "Authorization level for the production EmDash database token"
  type        = string
  default     = "full-access"
}

variable "turso_auth_token" {
  description = "Deprecated: Turso auth token for EmDash production database. Ignored when Terraform manages the database token."
  type        = string
  default     = ""
  sensitive   = true
}

variable "enable_editorial_gateway_policy" {
  description = "Enable APIM gateway JWT/role policy for production editorial API"
  type        = bool
  default     = true
}

variable "workspace_url" {
  description = "Workspace URL for production auth callbacks"
  type        = string
  default     = "https://freedomtimes.news"
}

variable "auth0_api_identifier" {
  description = "Auth0 API identifier (audience) for production"
  type        = string
  default     = "https://api.freedomtimes.news"
}

variable "apim_function_key" {
  description = "Optional APIM-to-Function host key injected in a follow-up apply"
  type        = string
  default     = ""
  sensitive   = true
}

variable "editorial_roles_claim" {
  description = "JWT claim name that carries editorial roles"
  type        = string
  default     = "https://freedomtimes.news/roles"
}

variable "editorial_allowed_roles" {
  description = "Allowed roles for production editorial API"
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
  description = "Custom API hostname for production APIM gateway"
  type        = string
  default     = "api.freedomtimes.news"
}

variable "api_custom_hostname_proxied" {
  description = "Whether Cloudflare should proxy the production API custom hostname CNAME"
  type        = bool
  default     = true
}

variable "api_custom_hostname_certificate_base64" {
  description = "Base64-encoded PFX certificate for production custom API hostname"
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_custom_hostname_certificate_password" {
  description = "Certificate password for production custom API hostname"
  type        = string
  default     = ""
  sensitive   = true
}

variable "worker_name" {
  description = "Worker name for the holding page"
  type        = string
  default     = "freedomtimes-holding"
}

variable "route_pattern" {
  description = "Route pattern for the holding page worker"
  type        = string
}

variable "manage_apex_dns_record" {
  description = "Whether to create a proxied apex A record for custom-domain routing"
  type        = bool
  default     = true
}

variable "apex_dns_record_content" {
  description = "IPv4 value for apex A record when manage_apex_dns_record is enabled"
  type        = string
  default     = "192.0.2.1"
}

variable "holding_title" {
  description = "Holding page HTML title"
  type        = string
  default     = "Freedom Times"
}

variable "holding_heading" {
  description = "Holding page heading"
  type        = string
  default     = "Freedom Times"
}

variable "holding_message" {
  description = "Holding page message"
  type        = string
  default     = "We are preparing the site. Please check back soon."
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
variable "api_management_allowed_origins" {
  description = "Allowed browser origins for production APIM CORS policy"
  type        = list(string)
  default     = ["https://freedomtimes.news"]
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