output "auth0_domain" {
  description = "Auth0 tenant domain"
  value       = module.auth0_app.domain
  sensitive   = true
}

output "auth0_client_id" {
  description = "Auth0 application client ID for local cult agent worker"
  value       = module.auth0_app.application_id
  sensitive   = true
}

output "auth0_client_secret" {
  description = "Auth0 application client secret (sensitive)"
  value       = module.auth0_app.client_secret
  sensitive   = true
}
