# Non-Terraform Managed Resources

This document describes infrastructure and configuration that **cannot be managed by Terraform** and must be set up manually. These are one-time bootstrap steps — once complete, Terraform takes over all further configuration.

> These steps are required before any `terraform apply` will succeed for a new environment.

---

## Auth0

Auth0 resources are managed by Terraform **except** for the two M2M applications below, which are used as credentials *by* Terraform and *by* the Post-Login Action. These must be created manually to avoid a bootstrapping circular dependency.

---

### 1. `freedomtimes-terraform` — Terraform Provider M2M App

This app authenticates the Terraform Auth0 provider to the Auth0 Management API. It allows Terraform to create and manage Auth0 resources (clients, roles, actions, resource servers, etc.).

**Corresponds to `.env.dev` vars:**
- `TF_VAR_auth0_management_client_id`
- `TF_VAR_auth0_management_client_secret`

#### Steps

1. Go to [Auth0 Dashboard](https://manage.auth0.com) → **Applications** → **Create Application**
2. Name: `freedomtimes-terraform`
3. Type: **Machine to Machine**
4. Click **Create**
5. On the next screen, select **Auth0 Management API** as the target API
6. Grant the following scopes:

   | Category | Scopes |
   |---|---|
   | Clients | `create:clients` `read:clients` `update:clients` `delete:clients` |
   | Client Grants | `create:client_grants` `read:client_grants` `update:client_grants` `delete:client_grants` |
   | Resource Servers | `create:resource_servers` `read:resource_servers` `update:resource_servers` `delete:resource_servers` |
   | Roles | `create:roles` `read:roles` `update:roles` `delete:roles` |
   | Actions | `create:actions` `read:actions` `update:actions` `delete:actions` |
   | Triggers | `read:triggers` `update:triggers` |

7. Click **Authorize**
8. Go to the **Settings** tab of the new application
9. Copy **Client ID** → set as `TF_VAR_auth0_management_client_id` in `.env.dev`
10. Copy **Client Secret** → set as `TF_VAR_auth0_management_client_secret` in `.env.dev`
11. Run `.\scripts\set-github-secrets.ps1` to push updated values to GitHub Actions

---

## After App Is Created

Once the Terraform provider M2M app is created and credentials are set:

1. Update `.env.dev` with the provider credentials and login app credentials (see `.env.dev.example` for variable names)
2. Run `.\scripts\set-github-secrets.ps1` to push secrets to GitHub Actions
3. Terraform will manage all further Auth0 configuration on next apply

---

## Why These Cannot Be in Terraform

The Auth0 Terraform provider uses client credentials from `TF_VAR_auth0_management_client_id` / `TF_VAR_auth0_management_client_secret` to authenticate against the Management API. Those credentials must already exist and be authorized before Terraform can run — so they cannot be resources that Terraform itself creates.

---

## Wrangler-owned Worker settings

Terraform's `cloudflare_workers_script.holding_page` (module `cloudflare_holding_page`) and
`wrangler deploy` both write the **same** Worker script. Ownership is split explicitly via
`lifecycle.ignore_changes` in that resource; Terraform never manages these attributes:

| Attribute | Owner | Where it is set |
|---|---|---|
| `content` (bundle), static assets, `plain_text` vars, KV / R2 bindings | Wrangler | `web/wrangler.jsonc` + `npm run build` |
| `compatibility_date`, `compatibility_flags` | Wrangler | `web/wrangler.jsonc` |
| `logpush`, `observability` | Wrangler | `web/wrangler.jsonc` |
| `placement` (`region: aws:eu-west-1`, next to the Turso primary) | Wrangler | `web/wrangler.jsonc` → `env.production.placement`, `env.staging.placement` |

`placement` must stay Wrangler-owned: in provider `cloudflare ~> 5.22` `placement.target[].region` is a
computed-only attribute (only `mode` is settable), so Terraform cannot express region placement.
Without the ignore, a Terraform upload (for example a secret rotation) could send script
settings without placement and silently revert to eyeball placement.

**Known plan drift on `cloudflare_workers_script.holding_page` (expected, "1 to change").** On refresh,
provider 5.22 adds every live non-secret binding that is not already in state to `bindings`
(`internal/services/workers_script/custom.go`: "Add any new elements from API that weren't in state
(except unmanaged secret_text bindings)"). Wrangler owns KV, R2, `plain_text` vars (`PAGE_CACHE`,
`SITE_ACCESS_MODE`, …) and `ASSETS`; Terraform config lists only `PAGE_VIEWS`, `EMAIL` and `secret_text`.
So after any Wrangler deploy the plan shows `~ bindings = (sensitive value)` and computed attributes
(`etag`, `modified_on`, `has_assets`, `placement.*`, `placement_mode`) as "known after apply". This is not
specific to `PAGE_CACHE` and predates placement. An apply of it is safe for vars (`keep_bindings` includes
`plain_text`, so `PAGE_CACHE` is kept, not switched off) but it **re-uploads the script** from state, which is
why every apply must be followed by the verification below. We deliberately do not mirror `wrangler.jsonc`
bindings into Terraform (two owners that can disagree) or add `bindings` to `ignore_changes` (Terraform owns
the `secret_text` bindings and secret rotations would silently stop applying).

**Check after a staging deploy (plan only, never apply from an agent):** `terraform plan` in
`infra/terraform/environments/staging` must show no Terraform-owned change on
`cloudflare_workers_script.holding_page` beyond the drift above (no `+`/`-` of `PAGE_VIEWS`, `EMAIL` or
`secret_text` names you did not intend, no replacement). Then confirm the live Worker with the Cloudflare API:

```bash
cd web && node scripts/verify-worker-placement.mjs --env staging   # or --env production
```

It checks placement `mode = targeted` + region `aws:eu-west-1`, `PAGE_CACHE` / `PAGE_CACHE_TTL_SECONDS` /
`SITE_ACCESS_MODE` equal to `wrangler.jsonc`, the `ASSETS` binding, and `last_deployed_from = wrangler`.
The `cf-placement` response header is **not** a valid check any more: Cloudflare documents it "may be
removed" and it is not emitted for this Worker
([Workers placement docs](https://developers.cloudflare.com/workers/configuration/placement/#cf-placement-header);
status via the API: [Check placement status](https://developers.cloudflare.com/workers/configuration/placement/#check-placement-status)).

**After any `terraform apply` (staging or production): verify `PAGE_CACHE` and placement.**
`scripts/terraform-run.ps1 -Operation apply` now runs the verifier itself and exits non-zero (4) on a
mismatch; the deploy scripts defer that check until after their `wrangler deploy`. If it fails, redeploy the
Worker with Wrangler (`pwsh scripts/deploy-<env>-local.ps1 -WorkerOnly`) or roll back to the last Wrangler
version.
