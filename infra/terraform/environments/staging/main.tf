provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "auth0" {
  domain        = var.auth0_domain
  client_id     = var.auth0_client_id
  client_secret = var.auth0_client_secret
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

  worker_secrets = {
    AUTH0_CLIENT_SECRET = var.auth0_app_client_secret
  }
}

module "auth0_app" {
  source = "../../modules/auth0_app"

  auth0_domain               = var.auth0_domain
  workspace_url              = "https://staging.freedomtimes.news"
  app_name                   = "freedomtimes-admin-staging"
  create_shared_resources    = true
  auth0_action_client_id     = var.auth0_action_client_id
  auth0_action_client_secret = var.auth0_action_client_secret
}
