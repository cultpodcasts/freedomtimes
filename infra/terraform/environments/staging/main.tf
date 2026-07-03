provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

/*
provider "azurerm" {
  features {}
}
*/

provider "auth0" {
  # Management client credentials: used only for Terraform to manage Auth0 resources
  domain        = var.auth0_domain
  client_id     = var.auth0_management_client_id
  client_secret = var.auth0_management_client_secret
}

provider "turso" {
  api_token = var.turso_api_token
}

locals {
  turso_database_group = trimspace(var.turso_database_group) != "" ? trimspace(var.turso_database_group) : null
  turso_database_token_expiration = trimspace(var.turso_database_token_expiration) != "" ? trimspace(var.turso_database_token_expiration) : null
  turso_database_size_limit = trimspace(var.turso_database_size_limit) != "" ? trimspace(var.turso_database_size_limit) : null
  scheduler_turso_database_group = trimspace(var.scheduler_turso_database_group) != "" ? trimspace(var.scheduler_turso_database_group) : local.turso_database_group
  scheduler_turso_database_token_expiration = trimspace(var.scheduler_turso_database_token_expiration) != "" ? trimspace(var.scheduler_turso_database_token_expiration) : local.turso_database_token_expiration
  scheduler_turso_database_size_limit = trimspace(var.scheduler_turso_database_size_limit) != "" ? trimspace(var.scheduler_turso_database_size_limit) : local.turso_database_size_limit
  subscriptions_turso_database_group = trimspace(var.subscriptions_turso_database_group) != "" ? trimspace(var.subscriptions_turso_database_group) : local.turso_database_group
  subscriptions_turso_database_token_expiration = trimspace(var.subscriptions_turso_database_token_expiration) != "" ? trimspace(var.subscriptions_turso_database_token_expiration) : local.turso_database_token_expiration
  subscriptions_turso_database_size_limit = trimspace(var.subscriptions_turso_database_size_limit) != "" ? trimspace(var.subscriptions_turso_database_size_limit) : local.turso_database_size_limit
  tips_turso_database_group = trimspace(var.tips_turso_database_group) != "" ? trimspace(var.tips_turso_database_group) : local.turso_database_group
  tips_turso_database_token_expiration = trimspace(var.tips_turso_database_token_expiration) != "" ? trimspace(var.tips_turso_database_token_expiration) : local.turso_database_token_expiration
  tips_turso_database_size_limit = trimspace(var.tips_turso_database_size_limit) != "" ? trimspace(var.tips_turso_database_size_limit) : local.turso_database_size_limit
  turso_database_url = format("libsql://%s", turso_database.emdash.hostname)
  scheduler_turso_database_url = format("libsql://%s", turso_database.scheduler.hostname)
  subscriptions_turso_database_url = format("libsql://%s", turso_database.subscriptions.hostname)
  tips_turso_database_url = format("libsql://%s", turso_database.tips.hostname)
}

resource "turso_database" "emdash" {
  organization_name = var.turso_organization
  name              = var.turso_database_name
  group             = local.turso_database_group
}

resource "turso_database_configuration" "emdash" {
  count = var.turso_database_delete_protection || local.turso_database_size_limit != null ? 1 : 0

  organization_slug = var.turso_organization
  database_name     = turso_database.emdash.name
  delete_protection = var.turso_database_delete_protection
  size_limit        = local.turso_database_size_limit
}

resource "turso_database_token" "emdash" {
  organization_name = var.turso_organization
  database_name     = turso_database.emdash.name
  authorization     = var.turso_database_token_authorization
  expiration        = local.turso_database_token_expiration
}

resource "turso_database" "scheduler" {
  organization_name = var.turso_organization
  name              = var.scheduler_turso_database_name
  group             = local.scheduler_turso_database_group
}

resource "turso_database_configuration" "scheduler" {
  count = var.scheduler_turso_database_delete_protection || local.scheduler_turso_database_size_limit != null ? 1 : 0

  organization_slug = var.turso_organization
  database_name     = turso_database.scheduler.name
  delete_protection = var.scheduler_turso_database_delete_protection
  size_limit        = local.scheduler_turso_database_size_limit
}

resource "turso_database_token" "scheduler" {
  organization_name = var.turso_organization
  database_name     = turso_database.scheduler.name
  authorization     = var.scheduler_turso_database_token_authorization
  expiration        = local.scheduler_turso_database_token_expiration
}

resource "turso_database" "subscriptions" {
  organization_name = var.turso_organization
  name              = var.subscriptions_turso_database_name
  group             = local.subscriptions_turso_database_group
}

resource "turso_database_configuration" "subscriptions" {
  count = var.subscriptions_turso_database_delete_protection || local.subscriptions_turso_database_size_limit != null ? 1 : 0

  organization_slug = var.turso_organization
  database_name     = turso_database.subscriptions.name
  delete_protection = var.subscriptions_turso_database_delete_protection
  size_limit        = local.subscriptions_turso_database_size_limit
}

resource "turso_database_token" "subscriptions" {
  organization_name = var.turso_organization
  database_name     = turso_database.subscriptions.name
  authorization     = var.subscriptions_turso_database_token_authorization
  expiration        = local.subscriptions_turso_database_token_expiration
}

resource "turso_database" "tips" {
  organization_name = var.turso_organization
  name              = var.tips_turso_database_name
  group             = local.tips_turso_database_group
}

resource "turso_database_configuration" "tips" {
  count = var.tips_turso_database_delete_protection || local.tips_turso_database_size_limit != null ? 1 : 0

  organization_slug = var.turso_organization
  database_name     = turso_database.tips.name
  delete_protection = var.tips_turso_database_delete_protection
  size_limit        = local.tips_turso_database_size_limit
}

resource "turso_database_token" "tips" {
  organization_name = var.turso_organization
  database_name     = turso_database.tips.name
  authorization     = var.tips_turso_database_token_authorization
  expiration        = local.tips_turso_database_token_expiration
}


module "cloudflare_holding_page" {
  source = "../../modules/cloudflare_holding_page"

  account_id = var.cloudflare_account_id
  zone_id    = var.cloudflare_zone_id

  worker_name   = var.worker_name
  route_pattern = var.route_pattern

  manage_apex_dns_record  = var.manage_apex_dns_record
  apex_dns_record_content = var.apex_dns_record_content

  holding_title   = var.holding_title
  holding_heading = var.holding_heading
  holding_message = var.holding_message
  build_revision  = var.build_revision
  contact_email   = var.contact_email

  worker_secrets = {
    TURSO_DATABASE_URL = local.turso_database_url
    TURSO_AUTH_TOKEN   = turso_database_token.emdash.jwt
  }
}

module "auth0_app" {
  source = "../../modules/auth0_app"

  # This module creates the login application for the staging web app. Its client ID is output as auth0_app_client_id.
  auth0_domain            = var.auth0_domain
  api_identifier          = var.auth0_api_identifier
  api_name                = "freedomtimes-api-staging"
  workspace_url           = var.workspace_url
  extra_callback_urls     = var.auth0_extra_callback_urls
  roles_claim_namespace   = trimsuffix(replace(var.editorial_roles_claim, "/roles", ""), "/")
  app_name                = "freedomtimes-admin-staging"
  create_shared_resources = false
  create_api_resource_server = true
  enable_machine_to_machine_grant = true
  jwt_signing_alg         = "RS256"
}

/*
module "azure_editorial_api" {
  source = "../../modules/azure_editorial_api"

  project_name = "freedomtimes"
  environment  = "staging"
  location     = var.azure_location

  auth0_domain             = module.auth0_app.domain
  auth0_api_audience       = module.auth0_app.api_identifier
  apim_function_key        = var.apim_function_key
  roles_claim              = var.editorial_roles_claim
  allowed_roles            = var.editorial_allowed_roles

  enable_api_gateway_policy = var.enable_editorial_gateway_policy
  api_management_publisher_name  = var.api_management_publisher_name
  api_management_publisher_email = var.api_management_publisher_email
  api_management_sku_name        = var.api_management_sku_name
  api_management_api_path        = var.api_management_api_path
  api_management_allowed_origins = var.api_management_allowed_origins
  api_management_gateway_custom_domain         = var.api_custom_hostname
  api_management_gateway_certificate_base64    = var.api_custom_hostname_certificate_base64
  api_management_gateway_certificate_password  = var.api_custom_hostname_certificate_password
  manage_api_management_gateway_custom_domain  = false

  tags = {
    project     = "freedomtimes"
    environment = "staging"
    managed_by  = "terraform"
  }
}

resource "cloudflare_record" "api_custom_hostname" {
  count = length(trimspace(var.api_custom_hostname)) > 0 && length(trimspace(var.api_custom_hostname_certificate_base64)) > 0 && length(trimspace(var.api_custom_hostname_certificate_password)) > 0 ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = var.api_custom_hostname
  type    = "CNAME"
  content = module.azure_editorial_api.api_gateway_hostname
  proxied = var.api_custom_hostname_proxied
  ttl     = 1
  allow_overwrite = true
}

resource "time_sleep" "wait_for_api_custom_hostname_dns" {
  count = length(trimspace(var.api_custom_hostname)) > 0 && length(trimspace(var.api_custom_hostname_certificate_base64)) > 0 && length(trimspace(var.api_custom_hostname_certificate_password)) > 0 ? 1 : 0

  create_duration = "90s"

  depends_on = [cloudflare_record.api_custom_hostname]
}

resource "azurerm_api_management_custom_domain" "editorial" {
  count = length(trimspace(var.api_custom_hostname)) > 0 && length(trimspace(var.api_custom_hostname_certificate_base64)) > 0 && length(trimspace(var.api_custom_hostname_certificate_password)) > 0 ? 1 : 0

  api_management_id = module.azure_editorial_api.api_management_id

  gateway {
    host_name            = trimspace(var.api_custom_hostname)
    certificate          = trimspace(var.api_custom_hostname_certificate_base64)
    certificate_password = trimspace(var.api_custom_hostname_certificate_password)
  }

  depends_on = [time_sleep.wait_for_api_custom_hostname_dns]
}
*/
