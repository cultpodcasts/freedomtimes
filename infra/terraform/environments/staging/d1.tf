# EmDash Cloudflare D1 content database (PR #198: Turso sync-quota outage, 23 Nov 2026).
#
# The database was created and hydrated out of band (wrangler OAuth) and is live: the staging Worker
# reads it through the Wrangler-owned d1 binding EMDASH (web/wrangler.jsonc). Terraform adopts it
# with an import block: no create, no replace, and prevent_destroy blocks a delete.
#
# Off by default (var.manage_emdash_d1_fallback) because the Terraform Cloudflare API token has no
# D1 permission yet: a plan that reads this resource would fail. To adopt:
#   1. Add "Account > D1 > Edit" to the Terraform Cloudflare API token (TF_VAR_CLOUDFLARE_API_TOKEN).
#   2. Set the GitHub repo variable TF_VAR_MANAGE_EMDASH_D1_FALLBACK=true (or TF_VAR_manage_emdash_d1_fallback=true locally).
#   3. Plan: expect "1 to import, 0 to add, 0 to destroy" for this resource.
# The EMDASH binding stays safe either way: modules/cloudflare_holding_page keeps "d1" bindings.
# See web/docs/CONTENT_BACKEND.md.

locals {
  emdash_d1_fallback_database_id = "ba03720b-f6f8-4ab1-b3cf-c2809b4bb0bf"
  emdash_d1_fallback_keys        = var.manage_emdash_d1_fallback ? toset(["emdash"]) : toset([])
}

import {
  for_each = local.emdash_d1_fallback_keys
  to       = cloudflare_d1_database.emdash_fallback[each.key]
  id       = "${var.cloudflare_account_id}/${local.emdash_d1_fallback_database_id}"
}

resource "cloudflare_d1_database" "emdash_fallback" {
  for_each = local.emdash_d1_fallback_keys

  account_id            = var.cloudflare_account_id
  name                  = "freedomtimes-emdash-staging-fallback-20261123"
  primary_location_hint = "weur"

  lifecycle {
    prevent_destroy = true
    # Location and replication are fixed at creation / managed in the dashboard; never replace.
    ignore_changes = [primary_location_hint, read_replication, jurisdiction]
  }
}