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

provider "neon" {
  api_key = var.neon_api_key
}

locals {
  emdash_database_url_pattern = "^postgres(?:ql)?://([^:]+):([^@]+)@([^:/?]+)(?::([0-9]+))?/([^?]+)"
  emdash_database_url_parts   = try(regex(local.emdash_database_url_pattern, nonsensitive(var.emdash_database_url)), [])
}

resource "neon_project" "emdash" {
  count = var.manage_neon_resources ? 1 : 0

  lifecycle {
    prevent_destroy = true
    ignore_changes  = all
  }
}

resource "neon_branch" "emdash" {
  count = var.manage_neon_resources ? 1 : 0

  project_id = neon_project.emdash[0].id
  name       = var.neon_branch_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "neon_endpoint" "emdash" {
  count = var.manage_neon_resources ? 1 : 0

  project_id = neon_project.emdash[0].id
  branch_id  = neon_branch.emdash[0].id

  lifecycle {
    prevent_destroy = true
  }
}

resource "neon_role" "emdash" {
  count = var.manage_neon_resources ? 1 : 0

  project_id = neon_project.emdash[0].id
  branch_id  = neon_branch.emdash[0].id
  name       = var.neon_role_name

  lifecycle {
    prevent_destroy = true
  }
}

resource "neon_database" "emdash" {
  count = var.manage_neon_resources ? 1 : 0

  project_id = neon_project.emdash[0].id
  branch_id  = neon_branch.emdash[0].id
  name       = var.neon_database_name
  owner_name = neon_role.emdash[0].name

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_hyperdrive_config" "emdash" {
  count = var.enable_hyperdrive && length(local.emdash_database_url_parts) == 5 ? 1 : 0

  account_id = var.cloudflare_account_id
  name       = var.hyperdrive_name

  origin = {
    database = local.emdash_database_url_parts[4]
    host     = local.emdash_database_url_parts[2]
    password = local.emdash_database_url_parts[1]
    port     = length(local.emdash_database_url_parts[3]) > 0 ? tonumber(local.emdash_database_url_parts[3]) : 5432
    scheme   = "postgresql"
    user     = local.emdash_database_url_parts[0]
  }

  lifecycle {
    prevent_destroy = true
  }
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

  hyperdrive_config_id = try(cloudflare_hyperdrive_config.emdash[0].id, "")
}

module "auth0_app" {
  source = "../../modules/auth0_app"

  # This module creates the login application for the staging web app. Its client ID is output as auth0_app_client_id.
  auth0_domain            = var.auth0_domain
  api_identifier          = var.auth0_api_identifier
  api_name                = "freedomtimes-api-staging"
  workspace_url           = var.workspace_url
  roles_claim_namespace   = trimsuffix(replace(var.editorial_roles_claim, "/roles", ""), "/")
  app_name                = "freedomtimes-admin-staging"
  create_shared_resources = false
  create_api_resource_server = true
  enable_machine_to_machine_grant = true
  jwt_signing_alg         = "RS256"
}

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
  emdash_database_url                                 = var.emdash_database_url

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
