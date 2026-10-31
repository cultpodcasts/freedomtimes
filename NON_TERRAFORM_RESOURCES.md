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

<a id="terraform-holding-page-drift"></a>
### Terraform drift on the Worker script: do not apply it on its own (canonical statement)

This is the single source for what the holding-page "1 to change" means and what to do about it. Other docs
link here instead of restating it.

**What the plan shows.** After any Wrangler deploy, `terraform plan` shows "1 to change" on
`cloudflare_workers_script.holding_page`: `~ bindings = (sensitive value)` plus computed attributes
(`etag`, `modified_on`, `has_assets`, `placement.*`, `placement_mode`) "known after apply". On refresh,
provider 5.22 adds every live non-secret binding that is not already in state to `bindings`
(`internal/services/workers_script/custom.go`: "Add any new elements from API that weren't in state
(except unmanaged secret_text bindings)"). Wrangler owns KV, R2, `plain_text` vars (`PAGE_CACHE`,
`SITE_ACCESS_MODE`, …) and the `ASSETS` binding (`assets.binding` in `wrangler.jsonc`); the Terraform config lists only `PAGE_VIEWS`, `EMAIL` and `secret_text`.
The drift is expected. It is **not** safe to apply on its own.

Production plans also show "1 to forget" for `turso_database_token.emdash` until a local apply records it.
That is the retired production EmDash token (`removed` block with `destroy = false`, [#137](https://github.com/cultpodcasts/freedomtimes/issues/137)):
Terraform drops it from state without calling Turso, and it is unrelated to the Worker script drift.

**Why applying it is not safe (confirmed facts).**

1. Any update to this resource is a full script upload (`PUT .../workers/scripts/<name>`, multipart), not a
   settings-only call. `keep_bindings` / `keep_assets` only keep bindings and assets; the upload replaces the
   script's modules.
2. The provider uploads exactly **one** module: `MarshalMultipart` writes `content` as a single part named
   after `main_module` (provider 5.22 `internal/services/workers_script/model.go`), which this module sets to
   `"worker.js"` (`infra/terraform/modules/cloudflare_holding_page/main.tf`).
3. That `content` comes from state, and `Read` stores only the **first** part of the live script's
   multipart content (`resource.go`: one `mr.NextPart()`). `content` is in `ignore_changes`, so Terraform
   never notices the difference.
4. The live Worker is multi-module. `npx wrangler deploy --dry-run` of the current build (no upload,
   27 Oct 2026, emdash 1.3.1, `@astrojs/cloudflare` 14.4.2) lists **690 ES modules** (21.4 MB); the main module
   `entry.mjs` imports `./chunks/entrypoints_*.mjs`.

**Consequence.** Cloudflare has **accepted** this upload: full staging and production deploys have applied
`0 added, 1 changed` on `holding_page` successfully (CA-12 and CA-23 in
[`web/docs/CLOUD_AGENT_DEPLOY_ISSUES.md`](web/docs/CLOUD_AGENT_DEPLOY_ISSUES.md)). So after the apply the live
Worker is Terraform's single-module upload, and it stays that way until `wrangler deploy` re-uploads the real
bundle. **Not measured:** whether that script serves errors in the meantime (it imports modules it does not
send). Since [#116](https://github.com/cultpodcasts/freedomtimes/issues/116) the full deploy builds the Worker
**before** the apply, so the window is Auth0 sync, secret sync and migrate (seconds), not `npm run build`
(minutes). After the apply the deploy resolves the Turso build credentials again and stops before migrate if the
apply changed the EmDash DB URL the build used. Outside the deploy nothing re-uploads the real bundle, so the
tooling blocks it:

- **Before apply:** `scripts/terraform-run.ps1 -Operation apply` (staging/production) plans to a file and runs
  `scripts/terraform-plan-guard-worker-script-upload.ps1`. Any planned create/update/replace/delete of
  `cloudflare_workers_script.holding_page` blocks the apply (exit 1) **unless** the run is part of a deploy that
  runs `wrangler deploy` later in the same run, after Auth0 sync, secret sync and migrate (the build already
  ran before the apply, [#116](https://github.com/cultpodcasts/freedomtimes/issues/116))
  (`FT_WRANGLER_DEPLOY_FOLLOWS=1`, set by `deploy-*-local.ps1`),
  or the operator passes the break-glass switch `-AllowWorkerScriptUpload`. For a non-Worker change, apply with
  `-Target` (for example `-Target 'cloudflare_dns_record.api_custom_hostname'`), or run the full
  `deploy-<env>-local.ps1`, which re-uploads the real bundle with Wrangler later in the same run. The saved-plan
  + `terraform show -json` path has only been tested with a fake `terraform`; checking it against the Terraform
  Cloud backend (plan only) before the next full deploy is [#117](https://github.com/cultpodcasts/freedomtimes/issues/117).
  If it does not work there, the guard fails closed and the deploy stops before applying.
- **GitHub Actions:** `terraform-staging.yml` and `terraform-production.yml` run the same guard
  (`Guard Worker Script Upload Plan`) on every plan, immediately before `Terraform Apply`. CI never sets
  `FT_WRANGLER_DEPLOY_FOLLOWS`, because the workflows have no failure recovery or placement check between the
  Terraform upload and a later `wrangler deploy`. So an apply dispatch whose plan touches `holding_page` is
  refused before anything is applied, migrated or deployed, even when the worker-deploy input is also set.
  While this drift exists (after every local deploy), **an apply dispatch is blocked by design**. Apply
  Worker-touching changes with `deploy-<env>-local.ps1`. On plan-only PR and push runs the guard is
  report-only: when the guard prints `BLOCKED:` it notes that an apply would be refused (the expected drift), and
  when it could not check the plan (no plan file, `terraform show -json` failed, unparseable JSON) it raises a
  `::warning` instead; the job still passes either way. Those runs also exercise the `terraform show -json` path
  against the Terraform Cloud backend (evidence for #117).
- **After apply:** `terraform-run.ps1` runs `web/scripts/verify-worker-placement.mjs`. Exit **4** = placement /
  `PAGE_CACHE` / `ASSETS` do not match `wrangler.jsonc`, or a static-asset / unmatched-route probe failed; exit **5** = could not verify (no token, API or
  network error, or a probe could not run: network error on every attempt, probe path not in the build); both print the redeploy command. The deploy scripts defer this check until after their
  `wrangler deploy`, and warn loudly if Terraform applied but `wrangler deploy` did not complete.
- **Recovery:** `pwsh scripts/deploy-<env>-local.ps1 -WorkerOnly -SkipVersionBump` (Wrangler redeploy), or roll
  back to the last Wrangler version in the Cloudflare dashboard.
- **Local tests (no network, fake `terraform` / `node`, no CI):**
  `pwsh -NoProfile -File ./scripts/test-terraform-worker-script-guards.ps1` and
  `pwsh -NoProfile -File ./scripts/test-deploy-cloud-agent-guards.ps1`.

We deliberately do not mirror `wrangler.jsonc` bindings into Terraform (two owners that can disagree) or add
`bindings` to `ignore_changes` (Terraform owns the `secret_text` bindings, and secret rotations would silently
stop applying). A secret rotation therefore goes through the full deploy (Terraform, then Wrangler).

**Check after a staging deploy (plan only, never apply from an agent):** `terraform plan` in
`infra/terraform/environments/staging` must show no Terraform-owned change on
`cloudflare_workers_script.holding_page` beyond the drift above (no `+`/`-` of `PAGE_VIEWS`, `EMAIL` or
`secret_text` names you did not intend, no replacement). Then confirm the live Worker with the Cloudflare API:

```bash
cd web && node scripts/verify-worker-placement.mjs --env staging   # or --env production
```

It checks placement `mode = targeted` + region `aws:eu-west-1`, `PAGE_CACHE` / `PAGE_CACHE_TTL_SECONDS` /
`SITE_ACCESS_MODE` equal to `wrangler.jsonc`, the assets binding named by `wrangler.jsonc` `assets.binding`
(`ASSETS`; a config without a binding name expects none), `has_assets` from the Cloudflare API, and
`last_deployed_from = wrangler`. It then makes two logged-out GETs on the environment's own origin
(`https://staging.freedomtimes.news` / `https://freedomtimes.news`): `/favicon.svg` must be HTTP 200 with a
non-HTML content-type (static assets are served before the Worker, so the staging login wall does not apply),
and `/__ft-verify/no-such-route/a/b` must not be 5xx (an unbound `env.ASSETS` makes every unmatched route 500;
any 4xx/3xx passes — the probe checks "no 5xx", not "is 404"). The static-asset URL gets a fresh
`?ft-verify=<ms>` cache-buster so an edge-cached copy cannot pass it, and `cf-cache-status` is logged. Each probe
retries up to 4 attempts, 5 s apart (a transient edge 5xx or a version still propagating does not fail the
deploy); every attempt's status is logged, never headers or cookies. Still failing after the last attempt =
mismatch (exit 1); a network error on every attempt = could not verify (exit 2).
`--no-asset-probe` skips both; `--asset-path` / `--asset-origin` override them.
The `cf-placement` response header is **not** a valid check any more: Cloudflare documents it "may be
removed" and it is not emitted for this Worker
([Workers placement docs](https://developers.cloudflare.com/workers/configuration/placement/#cf-placement-header);
status via the API: [Check placement status](https://developers.cloudflare.com/workers/configuration/placement/#check-placement-status)).

**After any `terraform apply` (staging or production):** see
[the canonical statement above](#terraform-holding-page-drift) (pre-apply guard, exit 4 / 5, recovery).
