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

variable "tags" {
  description = "Tags applied to supported Azure resources"
  type        = map(string)
  default     = {}
}
