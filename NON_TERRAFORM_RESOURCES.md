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
- `TF_VAR_auth0_client_id`
- `TF_VAR_auth0_client_secret`

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
9. Copy **Client ID** → set as `TF_VAR_auth0_client_id` in `.env.dev`
10. Copy **Client Secret** → set as `TF_VAR_auth0_client_secret` in `.env.dev`
11. Run `.\scripts\set-github-secrets.ps1` to push updated values to GitHub Actions

---

### 2. `freedomtimes-action` — Post-Login Action M2M App

This app is used inside the Auth0 Post-Login Action to call the Management API and retrieve a user's roles, which are then injected into the access token. Unlike the Terraform provider app, its **Management API client grant is managed by Terraform** (`auth0_client_grant.action_management_api`) — but the app itself must be created first.

**Corresponds to `.env.dev` vars:**
- `TF_VAR_auth0_action_client_id`
- `TF_VAR_auth0_action_client_secret`

#### Steps

1. Go to [Auth0 Dashboard](https://manage.auth0.com) → **Applications** → **Create Application**
2. Name: `freedomtimes-action`
3. Type: **Machine to Machine**
4. Click **Create**
5. On the next screen, select **Auth0 Management API** as the target API
6. Grant the following scopes (minimum required):

   | Category | Scopes |
   |---|---|
   | Users | `read:users` |
   | Roles | `read:roles` |

   > Note: Terraform will also manage this grant via `auth0_client_grant.action_management_api`. Granting here at creation time is required as an initial bootstrap only.

7. Click **Authorize**
8. Go to the **Settings** tab of the new application
9. Copy **Client ID** → set as `TF_VAR_auth0_action_client_id` in `.env.dev`
10. Copy **Client Secret** → set as `TF_VAR_auth0_action_client_secret` in `.env.dev`
11. Run `.\scripts\set-github-secrets.ps1` to push updated values to GitHub Actions

---

## After Both Apps Are Created

Once both M2M apps are created and credentials are set:

1. Update `.env.dev` with all four values (see `.env.dev.example` for variable names)
2. Run `.\scripts\set-github-secrets.ps1` to push secrets to GitHub Actions
3. Terraform will manage all further Auth0 configuration on next apply

---

## Why These Cannot Be in Terraform

The Auth0 Terraform provider uses client credentials from `TF_VAR_auth0_client_id` / `TF_VAR_auth0_client_secret` to authenticate against the Management API. Those credentials must already exist and be authorized before Terraform can run — so they cannot be resources that Terraform itself creates.

Similarly, `freedomtimes-action` must exist before its client ID can be passed as a variable to the `auth0_action` and `auth0_client_grant` resources.
