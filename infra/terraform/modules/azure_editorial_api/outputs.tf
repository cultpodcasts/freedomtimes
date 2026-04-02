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

output "editorial_api_public_base_url" {
  description = "Public base URL for editorial API through API Management"
  value       = length(azurerm_api_management.editorial) > 0 ? "${azurerm_api_management.editorial[0].gateway_url}/${azurerm_api_management_api.editorial[0].path}" : null
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
