locals {
  build_markup   = var.build_revision != "" ? "<p class=\"meta\">Build: ${var.build_revision}</p>" : ""
  contact_markup = var.contact_email != "" ? "<p class=\"meta\">Contact: ${var.contact_email}</p>" : ""

  worker_script = templatefile("${path.module}/worker.js.tftpl", {
    holding_title   = var.holding_title
    holding_heading = var.holding_heading
    holding_message = var.holding_message
    build_markup    = local.build_markup
    contact_markup  = local.contact_markup
  })

  # Extract hostname and determine if it's a subdomain
  # e.g. "staging.freedomtimes.news/*" → hostname "staging.freedomtimes.news", is_subdomain true
  # e.g. "freedomtimes.news/*" → hostname "freedomtimes.news", is_subdomain false
  route_hostname = split("/", var.route_pattern)[0]
  is_subdomain   = length(split(".", local.route_hostname)) > 2
}

resource "cloudflare_workers_script" "holding_page" {
  account_id = var.account_id
  name       = var.worker_name
  content    = local.worker_script
}

resource "cloudflare_workers_secret" "script_secrets" {
  for_each = toset(nonsensitive(keys(var.worker_secrets)))

  account_id  = var.account_id
  script_name = cloudflare_workers_script.holding_page.name
  name        = each.value
  secret_text = var.worker_secrets[each.value]
}

resource "cloudflare_workers_route" "holding_page" {
  count = local.is_subdomain ? 0 : 1

  zone_id     = var.zone_id
  pattern     = var.route_pattern
  script_name = cloudflare_workers_script.holding_page.name
}

# Subdomain: use Custom Domain binding — Cloudflare manages DNS automatically
resource "cloudflare_workers_domain" "holding_page" {
  count = local.is_subdomain ? 1 : 0

  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = local.route_hostname
  service    = cloudflare_workers_script.holding_page.name
}

resource "cloudflare_record" "apex" {
  count = var.manage_apex_dns_record ? 1 : 0

  zone_id = var.zone_id
  name    = "@"
  type    = "A"
  content = var.apex_dns_record_content
  proxied = true
  ttl     = 1
}

