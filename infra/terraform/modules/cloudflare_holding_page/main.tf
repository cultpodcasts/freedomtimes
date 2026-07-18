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
  # e.g. "staging.example.com/*" -> hostname "staging.example.com", is_subdomain true
  # e.g. "example.com/*" -> hostname "example.com", is_subdomain false
  route_hostname = split("/", var.route_pattern)[0]
  is_subdomain   = length(split(".", local.route_hostname)) > 2

  # Terraform-owned bindings. Wrangler owns KV/R2/plain_text/ASSETS and the live Astro bundle.
  # keep_assets + keep_bindings preserve Wrangler-owned pieces across TF script metadata updates.
  page_views_bindings = trimspace(var.page_views_dataset) != "" ? [
    {
      name    = var.page_views_binding_name
      type    = "analytics_engine"
      dataset = var.page_views_dataset
    }
  ] : []

  send_email_bindings = var.enable_send_email ? [
    {
      name                      = var.send_email_binding_name
      type                      = "send_email"
      allowed_sender_addresses  = var.send_email_allowed_sender_addresses
    }
  ] : []

  secret_text_bindings = [
    for name, value in var.worker_secrets : {
      name = name
      type = "secret_text"
      text = value
    }
  ]

  worker_bindings = jsondecode(jsonencode(concat(
    local.page_views_bindings,
    local.send_email_bindings,
    local.secret_text_bindings,
  )))
}

resource "cloudflare_workers_script" "holding_page" {
  account_id  = var.account_id
  script_name = var.worker_name
  content     = local.worker_script
  # Module syntax Worker (matches previous module = true).
  main_module = "worker.js"
  compatibility_date = var.worker_compatibility_date
  logpush    = true

  bindings = local.worker_bindings

  # Wrangler owns the Astro/EmDash Worker bundle + static assets + wrangler.jsonc vars.
  # Without these, a TF bindings-only upload drops ASSETS / plain_text and breaks SSR
  # routes (staging symptom: GET /auth/login → HTTP 400 "Missing slug").
  keep_assets = true
  keep_bindings = [
    "assets",
    "kv_namespace",
    "plain_text",
    "r2_bucket",
  ]

  # Wrangler owns deployed Worker bundle content and most runtime metadata.
  # Terraform owns: PAGE_VIEWS analytics_engine, EMAIL send_email, and secret_text worker secrets.
  # Do not ignore main_module: empty main_module in state (post-Wrangler refresh) makes
  # bindings-only PUTs upload ESM as a service worker (Cloudflare 10021).
  lifecycle {
    ignore_changes = [
      content,
      compatibility_date,
      compatibility_flags,
      logpush,
      observability,
    ]
  }
}

# v4 cloudflare_workers_secret was removed in provider v5. Leave existing Secrets-API
# entries in Cloudflare (destroy = false) while secret_text bindings above become source of truth.
removed {
  from = cloudflare_workers_secret.script_secrets

  lifecycle {
    destroy = false
  }
}

resource "cloudflare_workers_route" "holding_page" {
  count = local.is_subdomain ? 0 : 1

  zone_id = var.zone_id
  pattern = var.route_pattern
  script  = cloudflare_workers_script.holding_page.script_name
}

# Subdomain: Custom Domain binding — Cloudflare manages DNS automatically.
# Provider v5: cloudflare_workers_domain → cloudflare_workers_custom_domain
# (no MoveState from our prior plural type). Staging imported via migrations
# file (removed after apply). Live Cloudflare binding was never destroyed.
removed {
  from = cloudflare_workers_domain.holding_page

  lifecycle {
    destroy = false
  }
}

resource "cloudflare_workers_custom_domain" "holding_page" {
  count = local.is_subdomain ? 1 : 0

  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = local.route_hostname
  service    = cloudflare_workers_script.holding_page.script_name
}

resource "cloudflare_dns_record" "apex" {
  count = var.manage_apex_dns_record ? 1 : 0

  zone_id = var.zone_id
  name    = "@"
  type    = "A"
  content = var.apex_dns_record_content
  proxied = true
  ttl     = 1
}

moved {
  from = cloudflare_record.apex
  to   = cloudflare_dns_record.apex
}
