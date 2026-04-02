output "resource_group_name" {
  description = "Azure Resource Group name for editorial API resources"
  value       = azurerm_resource_group.editorial.name
}

output "function_app_name" {
  description = "Azure Linux Function App name"
  value       = azurerm_function_app_flex_consumption.editorial.name
}

output "function_default_hostname" {
  description = "Default hostname for the Azure Function App"
  value       = azurerm_function_app_flex_consumption.editorial.default_hostname
}

output "api_management_name" {
  description = "API Management service name when gateway policy is enabled"
  value       = length(azurerm_api_management.editorial) > 0 ? azurerm_api_management.editorial[0].name : null
}

output "api_gateway_url" {
  description = "API Management gateway URL when gateway policy is enabled"
  value       = length(azurerm_api_management.editorial) > 0 ? azurerm_api_management.editorial[0].gateway_url : null
}

output "api_gateway_hostname" {
  description = "API Management default gateway hostname when gateway policy is enabled"
  value       = length(azurerm_api_management.editorial) > 0 ? trimsuffix(trimprefix(azurerm_api_management.editorial[0].gateway_url, "https://"), "/") : null
}

output "application_insights_name" {
  description = "Application Insights resource name for editorial API telemetry"
  value       = azurerm_application_insights.editorial.name
}

output "application_insights_connection_string" {
  description = "Application Insights connection string for editorial API telemetry"
  value       = azurerm_application_insights.editorial.connection_string
  sensitive   = true
}

output "log_analytics_workspace_name" {
  description = "Log Analytics workspace name for editorial API telemetry"
  value       = azurerm_log_analytics_workspace.editorial.name
}

output "editorial_api_public_base_url" {
  description = "Public base URL for editorial API through API Management"
  value = length(azurerm_api_management.editorial) > 0 ? format(
    "https://%s/%s",
    length(trimspace(var.api_management_gateway_custom_domain)) > 0 && length(trimspace(var.api_management_gateway_certificate_base64)) > 0 && length(trimspace(var.api_management_gateway_certificate_password)) > 0 ? trimspace(var.api_management_gateway_custom_domain) : trimsuffix(trimprefix(azurerm_api_management.editorial[0].gateway_url, "https://"), "/"),
    azurerm_api_management_api.editorial[0].path,
  ) : null
}

output "cosmos_account_name" {
  description = "Azure Cosmos DB account name"
  value       = azurerm_cosmosdb_account.editorial.name
}

output "cosmos_endpoint" {
  description = "Cosmos DB endpoint URL"
  value       = azurerm_cosmosdb_account.editorial.endpoint
}

output "cosmos_database_name" {
  description = "Cosmos DB SQL database name"
  value       = azurerm_cosmosdb_sql_database.editorial.name
}

output "stories_container_name" {
  description = "Cosmos DB stories container name"
  value       = azurerm_cosmosdb_sql_container.stories.name
}

output "media_container_name" {
  description = "Cosmos DB media container name"
  value       = azurerm_cosmosdb_sql_container.media.name
}

output "subscribers_container_name" {
  description = "Cosmos DB subscribers container name"
  value       = azurerm_cosmosdb_sql_container.subscribers.name
}
