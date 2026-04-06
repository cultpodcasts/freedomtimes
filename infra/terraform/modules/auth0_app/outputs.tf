output "application_id" {
  description = "Auth0 application client ID"
  value       = auth0_client.admin_ui.client_id
}

output "domain" {
  description = "Auth0 tenant domain"
  value       = var.auth0_domain
}

output "api_identifier" {
  description = "Auth0 API identifier"
  value       = var.create_shared_resources ? auth0_resource_server.api[0].identifier : var.api_identifier
}

output "editor_role_id" {
  description = "Editor role ID"
  value       = var.create_shared_resources ? auth0_role.editor[0].id : null
}

output "admin_role_id" {
  description = "Admin role ID"
  value       = var.create_shared_resources ? auth0_role.admin[0].id : null
}

# Output the Auth0 client secret (for automation)
output "client_secret" {
  description = "Auth0 application client secret (for automation only, do not expose in logs)"
  value       = auth0_client_credentials.admin_ui.client_secret
}
