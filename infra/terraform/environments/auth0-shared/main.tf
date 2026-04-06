provider "auth0" {
  # Management client credentials: used only for Terraform to manage Auth0 resources
  domain        = var.auth0_domain
  client_id     = var.auth0_management_client_id
  client_secret = var.auth0_management_client_secret
}

module "auth0_app" {
  source = "../../modules/auth0_app"

  # Shared tenant resources (API, roles, post-login action) are managed here.
  create_shared_resources = true
  create_login_app        = false

  auth0_domain          = var.auth0_domain
  api_identifier        = var.auth0_api_identifier
  roles_claim_namespace = trimsuffix(replace(var.editorial_roles_claim, "/roles", ""), "/")

  # Required input; login app is disabled in this environment.
  workspace_url = var.workspace_url
}
