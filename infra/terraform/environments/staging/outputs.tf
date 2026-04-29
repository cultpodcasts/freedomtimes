output "worker_name" {
  description = "Name of the deployed holding page worker"
  value       = module.cloudflare_holding_page.worker_name
}

output "route_pattern" {
  description = "Route pattern attached to the holding page worker"
  value       = module.cloudflare_holding_page.route_pattern
}

output "auth0_app_client_id" {
  description = "Auth0 login application client ID for the staging web app (not the management client)"
  value       = module.auth0_app.application_id
}

output "auth0_app_client_secret" {
  description = "Auth0 login application client secret for staging (sensitive)"
  value       = module.auth0_app.client_secret
  sensitive   = true
}

output "auth0_api_identifier" {
  description = "Auth0 API audience/identifier for staging tokens"
  value       = module.auth0_app.api_identifier
}

/*
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

output "azure_application_insights_name" {
  description = "Application Insights name for staging editorial API telemetry"
  value       = module.azure_editorial_api.application_insights_name
}

output "azure_log_analytics_workspace_name" {
  description = "Log Analytics workspace name for staging editorial API telemetry"
  value       = module.azure_editorial_api.log_analytics_workspace_name
}

output "azure_editorial_api_public_base_url" {
  description = "Public API base URL through APIM for staging editorial API"
  value       = nonsensitive(module.azure_editorial_api.editorial_api_public_base_url)
}
*/

output "turso_database_name" {
  description = "Turso database name for staging EmDash"
  value       = turso_database.emdash.name
}

output "turso_database_url" {
  description = "libSQL URL for the staging EmDash database"
  value       = local.turso_database_url
}

output "turso_database_auth_token" {
  description = "Application auth token for the staging EmDash database"
  value       = turso_database_token.emdash.jwt
  sensitive   = true
}

output "scheduler_turso_database_name" {
  description = "Turso database name for the staging scheduler workload"
  value       = turso_database.scheduler.name
}

output "scheduler_turso_database_url" {
  description = "libSQL URL for the staging scheduler database"
  value       = local.scheduler_turso_database_url
}

output "scheduler_turso_database_auth_token" {
  description = "Application auth token for the staging scheduler database"
  value       = turso_database_token.scheduler.jwt
  sensitive   = true
}

output "subscriptions_turso_database_name" {
  description = "Turso database name for the staging subscriptions workload"
  value       = turso_database.subscriptions.name
}

output "subscriptions_turso_database_url" {
  description = "libSQL URL for the staging subscriptions database"
  value       = local.subscriptions_turso_database_url
}

output "subscriptions_turso_database_auth_token" {
  description = "Application auth token for the staging subscriptions database"
  value       = turso_database_token.subscriptions.jwt
  sensitive   = true
}
