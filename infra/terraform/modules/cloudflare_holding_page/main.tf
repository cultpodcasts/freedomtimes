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

  # Extract subdomain from route pattern, e.g., "staging.freedomtimes.news/*" → "staging"
  route_subdomain = split(".", split(var.route_pattern, "/")[0])[0]
  is_subdomain    = local.route_subdomain != var.zone_id
}

resource "cloudflare_workers_script" "holding_page" {
  account_id = var.account_id
  name       = var.worker_name
  content    = local.worker_script
}

resource "cloudflare_workers_route" "holding_page" {
  zone_id     = var.zone_id
  pattern     = var.route_pattern
  script_name = cloudflare_workers_script.holding_page.name
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

resource "cloudflare_record" "subdomain" {
  count = local.is_subdomain ? 1 : 0

  zone_id = var.zone_id
  name    = local.route_subdomain
  type    = "CNAME"
  content = "${var.account_id}.workers.dev"
  proxied = true
  ttl     = 1
}
