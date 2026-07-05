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

output "tenant_session_lifetime_hours" {
  description = "Auth0 tenant session_lifetime (hours) currently applied, or null if unmanaged"
  value       = var.manage_tenant_session_lifetime ? auth0_tenant.main[0].session_lifetime : null
}

output "tenant_idle_session_lifetime_hours" {
  description = "Auth0 tenant idle_session_lifetime (hours) currently applied, or null if unmanaged"
  value       = var.manage_tenant_session_lifetime ? auth0_tenant.main[0].idle_session_lifetime : null
}
