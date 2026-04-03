output "worker_name" {
  description = "Name of the deployed holding page worker"
  value       = module.cloudflare_holding_page.worker_name
}

output "route_pattern" {
  description = "Route pattern attached to the holding page worker"
  value       = module.cloudflare_holding_page.route_pattern
}

output "auth0_app_client_id" {
  description = "Auth0 login application client ID for the production web app (not the management client)"
  value       = module.auth0_app.application_id
}

output "azure_resource_group_name" {
  description = "Resource Group name for production editorial API resources"
  value       = module.azure_editorial_api.resource_group_name
}

output "azure_function_app_name" {
  description = "Function App name for production editorial API"
  value       = module.azure_editorial_api.function_app_name
}

output "azure_cosmos_account_name" {
  description = "Cosmos DB account name for production editorial API"
  value       = module.azure_editorial_api.cosmos_account_name
}

output "azure_api_management_name" {
  description = "API Management service name for production editorial API"
  value       = module.azure_editorial_api.api_management_name
}

output "azure_application_insights_name" {
  description = "Application Insights name for production editorial API telemetry"
  value       = module.azure_editorial_api.application_insights_name
}

output "azure_log_analytics_workspace_name" {
  description = "Log Analytics workspace name for production editorial API telemetry"
  value       = module.azure_editorial_api.log_analytics_workspace_name
}

output "azure_editorial_api_public_base_url" {
  description = "Public API base URL through APIM for production editorial API"
  value       = nonsensitive(module.azure_editorial_api.editorial_api_public_base_url)
}
