output "auth0_api_identifier" {
  description = "Shared Auth0 API identifier"
  value       = module.auth0_app.api_identifier
}

output "auth0_editor_role_id" {
  description = "Shared editor role ID"
  value       = module.auth0_app.editor_role_id
}

output "auth0_admin_role_id" {
  description = "Shared admin role ID"
  value       = module.auth0_app.admin_role_id
}
