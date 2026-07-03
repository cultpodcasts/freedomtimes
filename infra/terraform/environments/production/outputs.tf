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

output "auth0_app_client_secret" {
  description = "Auth0 login application client secret for the production web app (for automation only, do not expose in logs)"
  value       = module.auth0_app.client_secret
  sensitive   = true
}

/*
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
*/

output "turso_database_name" {
  description = "Turso database name for production EmDash"
  value       = turso_database.emdash.name
}

output "turso_database_url" {
  description = "libSQL URL for the production EmDash database"
  value       = local.turso_database_url
}

output "turso_database_auth_token" {
  description = "Application auth token for the production EmDash database"
  value       = turso_database_token.emdash.jwt
  sensitive   = true
}

output "scheduler_turso_database_name" {
  description = "Turso database name for the production scheduler workload"
  value       = turso_database.scheduler.name
}

output "scheduler_turso_database_url" {
  description = "libSQL URL for the production scheduler database"
  value       = local.scheduler_turso_database_url
}

output "scheduler_turso_database_auth_token" {
  description = "Application auth token for the production scheduler database"
  value       = turso_database_token.scheduler.jwt
  sensitive   = true
}

output "subscriptions_turso_database_name" {
  description = "Turso database name for the production subscriptions workload"
  value       = turso_database.subscriptions.name
}

output "subscriptions_turso_database_url" {
  description = "libSQL URL for the production subscriptions database"
  value       = local.subscriptions_turso_database_url
}

output "subscriptions_turso_database_auth_token" {
  description = "Application auth token for the production subscriptions database"
  value       = turso_database_token.subscriptions.jwt
  sensitive   = true
}

output "tips_turso_database_name" {
  description = "Turso database name for the production tips workload"
  value       = turso_database.tips.name
}

output "tips_turso_database_url" {
  description = "libSQL URL for the production tips database"
  value       = local.tips_turso_database_url
}

output "tips_turso_database_auth_token" {
  description = "Application auth token for the production tips database"
  value       = turso_database_token.tips.jwt
  sensitive   = true
}
