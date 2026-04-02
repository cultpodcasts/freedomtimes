variable "project_name" {
  description = "Project name prefix used in Azure resource naming"
  type        = string
  default     = "freedomtimes"
}

variable "environment" {
  description = "Environment name (for example: staging, production)"
  type        = string
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "uksouth"
}

variable "resource_group_name" {
  description = "Optional override for the resource group name"
  type        = string
  default     = null
}

variable "function_app_name" {
  description = "Optional override for the Linux Function App name"
  type        = string
  default     = null
}

variable "cosmos_account_name" {
  description = "Optional override for the Cosmos DB account name"
  type        = string
  default     = null
}

variable "storage_account_name" {
  description = "Optional override for the Storage Account name"
  type        = string
  default     = null
}

variable "service_plan_name" {
  description = "Optional override for the App Service Plan name"
  type        = string
  default     = null
}

variable "cosmos_database_name" {
  description = "Cosmos DB SQL database name"
  type        = string
  default     = "freedomtimes"
}

variable "stories_container_name" {
  description = "Cosmos DB SQL container name for stories"
  type        = string
  default     = "stories"
}

variable "media_container_name" {
  description = "Cosmos DB SQL container name for media"
  type        = string
  default     = "media"
}

variable "subscribers_container_name" {
  description = "Cosmos DB SQL container name for subscribers"
  type        = string
  default     = "subscribers"
}

variable "node_version" {
  description = "Node.js runtime version for Azure Functions"
  type        = string
  default     = "20"
}

variable "enable_easy_auth" {
  description = "Enable Function App EasyAuth with Auth0 OIDC"
  type        = bool
  default     = true
}

variable "enable_api_gateway_policy" {
  description = "Enable API Management gateway and JWT/role policy in front of the Function App"
  type        = bool
  default     = true
}

variable "auth0_domain" {
  description = "Auth0 tenant domain used for OIDC discovery (for example: tenant.uk.auth0.com)"
  type        = string
  default     = ""
}

variable "auth0_editorial_client_id" {
  description = "Auth0 application client ID used by EasyAuth custom OIDC provider"
  type        = string
  default     = ""
}

variable "auth0_api_audience" {
  description = "Expected audience in JWT tokens for editorial API"
  type        = string
  default     = ""
}

variable "roles_claim" {
  description = "JWT claim name that contains application roles"
  type        = string
  default     = "https://freedomtimes.news/roles"
}

variable "allowed_roles" {
  description = "Allowed roles for editorial API requests"
  type        = list(string)
  default     = ["admin", "editor"]
}

variable "api_management_name" {
  description = "Optional override for API Management service name"
  type        = string
  default     = null
}

variable "api_management_sku_name" {
  description = "SKU for API Management service (for example: Consumption_0)"
  type        = string
  default     = "Consumption_0"
}

variable "api_management_publisher_name" {
  description = "Publisher display name required by API Management"
  type        = string
  default     = "Freedom Times"
}

variable "api_management_publisher_email" {
  description = "Publisher email required by API Management"
  type        = string
  default     = "platform@freedomtimes.news"
}

variable "api_management_api_name" {
  description = "API name within API Management"
  type        = string
  default     = "editorial-api"
}

variable "api_management_api_path" {
  description = "Public API path segment within API Management"
  type        = string
  default     = "editorial"
}

variable "api_management_gateway_custom_domain" {
  description = "Optional custom hostname for APIM gateway (for example: api-staging.freedomtimes.news)"
  type        = string
  default     = ""
}

variable "api_management_gateway_certificate_base64" {
  description = "Base64-encoded PFX certificate for APIM custom gateway hostname"
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_management_gateway_certificate_password" {
  description = "Password for APIM custom gateway hostname certificate"
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_management_allowed_origins" {
  description = "Allowed browser origins for APIM CORS policy"
  type        = list(string)
  default     = ["https://staging.freedomtimes.news", "https://freedomtimes.news"]
}

variable "enable_api_management_diagnostics" {
  description = "Enable API Management diagnostics and App Insights logger for the editorial API"
  type        = bool
  default     = true
}

variable "log_analytics_retention_in_days" {
  description = "Retention period in days for Log Analytics workspace data"
  type        = number
  default     = 30
}

variable "tags" {
  description = "Tags applied to supported Azure resources"
  type        = map(string)
  default     = {}
}
