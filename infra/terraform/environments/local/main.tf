provider "auth0" {
  domain        = var.auth0_domain
  client_id     = var.auth0_management_client_id
  client_secret = var.auth0_management_client_secret
}

module "auth0_app" {
  source = "../../modules/auth0_app"

  auth0_domain            = var.auth0_domain
  api_identifier          = var.auth0_api_identifier
  api_name                = "freedomtimes-api-local"
  workspace_url           = "http://local.freedomtimes.news:8787"
  extra_callback_urls     = ["http://local.freedomtimes.news:8787/ui/auth/callback"]
  roles_claim_namespace   = trimsuffix(replace(var.editorial_roles_claim, "/roles", ""), "/")
  app_name                = "freedomtimes-cult-agent-local"
  create_shared_resources = false
  create_api_resource_server = false
  jwt_signing_alg         = "RS256"
}
