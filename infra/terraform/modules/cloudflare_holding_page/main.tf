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
}

resource "cloudflare_workers_script" "holding_page" {
  account_id = var.account_id
  name       = var.worker_name
  content    = local.worker_script
  module     = true
  compatibility_date = var.worker_compatibility_date
  logpush    = true

  # Terraform owns the Analytics Engine dataset name + binding identity.
  # Wrangler must use the same dataset string (see terraform output page_views_dataset).
  dynamic "analytics_engine_binding" {
    for_each = trimspace(var.page_views_dataset) != "" ? [1] : []
    content {
      name    = var.page_views_binding_name
      dataset = var.page_views_dataset
    }
  }

  # Wrangler owns deployed Worker bundle content and most runtime metadata; Terraform manages name/routing/AE identity.
  # send_email (EMAIL) is declared in web/wrangler.jsonc — Cloudflare provider 4.x has no send_email binding schema
  # (see web/docs/EMDASH_CLOUDFLARE_EMAIL.md). Do not strip it via ad-hoc wrangler binding edits.
  lifecycle {
    ignore_changes = [
      content,
      module,
      compatibility_date,
      compatibility_flags,
      logpush,
      tags,
      plain_text_binding,
      r2_bucket_binding,
      kv_namespace_binding,
    ]
    # analytics_engine_binding is NOT ignored — Terraform is source of truth for PAGE_VIEWS dataset id
  }
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
