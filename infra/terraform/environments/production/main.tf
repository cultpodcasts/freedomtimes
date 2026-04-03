provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "azurerm" {
  features {}
}

provider "auth0" {
  # Management client credentials: used only for Terraform to manage Auth0 resources
  domain        = var.auth0_domain
  client_id     = var.auth0_management_client_id
  client_secret = var.auth0_management_client_secret
}

module "cloudflare_holding_page" {
  source = "../../modules/cloudflare_holding_page"

  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id

  worker_name   = var.worker_name
  route_pattern = var.route_pattern

  manage_apex_dns_record = var.manage_apex_dns_record
  apex_dns_record_content = var.apex_dns_record_content

  holding_title   = var.holding_title
  holding_heading = var.holding_heading
  holding_message = var.holding_message
  build_revision  = var.build_revision
  contact_email   = var.contact_email
}

module "auth0_app" {
  source = "../../modules/auth0_app"

  # This module creates the login application for the web app. Its client ID is output as auth0_app_client_id.
  app_name              = "freedomtimes-admin"
  api_identifier        = var.auth0_api_identifier
  workspace_url         = var.workspace_url
  roles_claim_namespace = trimsuffix(replace(var.editorial_roles_claim, "/roles", ""), "/")
  auth0_domain          = var.auth0_domain
  extra_workspace_urls  = var.extra_workspace_urls
}

module "azure_editorial_api" {
  source = "../../modules/azure_editorial_api"

  project_name = "freedomtimes"
  environment  = "production"
  location     = var.azure_location

  auth0_domain              = module.auth0_app.domain
  auth0_api_audience        = module.auth0_app.api_identifier
  apim_function_key         = var.apim_function_key
  roles_claim               = var.editorial_roles_claim
  allowed_roles             = var.editorial_allowed_roles

  enable_api_gateway_policy = var.enable_editorial_gateway_policy
  api_management_publisher_name  = var.api_management_publisher_name
  api_management_publisher_email = var.api_management_publisher_email
  api_management_sku_name        = var.api_management_sku_name
  api_management_api_path        = var.api_management_api_path
  api_management_gateway_custom_domain         = var.api_custom_hostname
  api_management_gateway_certificate_base64    = var.api_custom_hostname_certificate_base64
  api_management_gateway_certificate_password  = var.api_custom_hostname_certificate_password

  tags = {
    project     = "freedomtimes"
    environment = "production"
    managed_by  = "terraform"
  }
}

resource "cloudflare_record" "api_custom_hostname" {
  count = length(trimspace(var.api_custom_hostname)) > 0 && length(trimspace(var.api_custom_hostname_certificate_base64)) > 0 && length(trimspace(var.api_custom_hostname_certificate_password)) > 0 && module.azure_editorial_api.api_gateway_hostname != null ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = var.api_custom_hostname
  type    = "CNAME"
  content = module.azure_editorial_api.api_gateway_hostname
  proxied = true
  ttl     = 1
}
