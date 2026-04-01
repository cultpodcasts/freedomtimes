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
  value       = auth0_resource_server.api.identifier
}

output "editor_role_id" {
  description = "Editor role ID"
  value       = auth0_role.editor.id
}

output "admin_role_id" {
  description = "Admin role ID"
  value       = auth0_role.admin.id
}
