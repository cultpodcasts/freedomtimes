output "resource_group_name" {
  description = "Azure Resource Group name for editorial API resources"
  value       = azurerm_resource_group.editorial.name
}

output "function_app_name" {
  description = "Azure Linux Function App name"
  value       = azurerm_linux_function_app.editorial.name
}

output "function_default_hostname" {
  description = "Default hostname for the Azure Function App"
  value       = azurerm_linux_function_app.editorial.default_hostname
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
