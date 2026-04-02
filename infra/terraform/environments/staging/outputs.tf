output "worker_name" {
  description = "Name of the deployed holding page worker"
  value       = module.cloudflare_holding_page.worker_name
}

output "route_pattern" {
  description = "Route pattern attached to the holding page worker"
  value       = module.cloudflare_holding_page.route_pattern
}

output "auth0_app_client_id" {
  description = "Auth0 app client ID for the staging application"
  value       = module.auth0_app.application_id
}

output "azure_resource_group_name" {
  description = "Resource Group name for staging editorial API resources"
  value       = module.azure_editorial_api.resource_group_name
}

output "azure_function_app_name" {
  description = "Function App name for staging editorial API"
  value       = module.azure_editorial_api.function_app_name
}

output "azure_cosmos_account_name" {
  description = "Cosmos DB account name for staging editorial API"
  value       = module.azure_editorial_api.cosmos_account_name
}

output "azure_api_management_name" {
  description = "API Management service name for staging editorial API"
  value       = module.azure_editorial_api.api_management_name
}

output "azure_editorial_api_public_base_url" {
  description = "Public API base URL through APIM for staging editorial API"
  value       = module.azure_editorial_api.editorial_api_public_base_url
}
