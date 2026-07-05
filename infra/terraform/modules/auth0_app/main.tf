locals {
  base_urls = distinct(concat([var.workspace_url], var.extra_workspace_urls))
  callback_urls = distinct(concat([for url in local.base_urls : "${url}/auth/callback"], var.extra_callback_urls))
  create_api_resource_server = var.create_shared_resources || var.create_api_resource_server
  login_app_grant_types = var.enable_machine_to_machine_grant ? ["authorization_code", "refresh_token", "client_credentials"] : ["authorization_code", "refresh_token"]
}

# Auth0 Client (Regular Web App for server-side code exchange)
resource "auth0_client" "admin_ui" {
  count           = var.create_login_app ? 1 : 0
  name            = var.app_name
  app_type        = "regular_web"
  grant_types     = local.login_app_grant_types

  callbacks             = local.callback_urls
  allowed_logout_urls   = local.base_urls
  allowed_origins       = local.base_urls
  web_origins           = local.base_urls

  custom_login_page_on = false
  is_first_party       = true

  oidc_conformant      = true

  jwt_configuration {
    alg                 = var.jwt_signing_alg
    lifetime_in_seconds = var.id_token_lifetime_in_seconds
    secret_encoded      = true
  }

  # Refresh token grant is already in local.login_app_grant_types. This block sets Auth0's
  # rotation/lifetime policy for it. See var.enable_refresh_token_rotation description: the web
  # app does not yet use offline_access/refresh_token client-side, so this is a forward-looking
  # policy, not (by itself) a change to the currently observed re-sign-in interval.
  dynamic "refresh_token" {
    for_each = var.enable_refresh_token_rotation ? [1] : []
    content {
      rotation_type                 = "rotating"
      expiration_type               = "expiring"
      leeway                        = var.refresh_token_leeway
      token_lifetime                = var.refresh_token_lifetime_seconds
      idle_token_lifetime           = var.refresh_token_idle_lifetime_seconds
      infinite_token_lifetime       = false
      infinite_idle_token_lifetime  = false
    }
  }
}

# Configure the app to use client_secret_post authentication.
resource "auth0_client_credentials" "admin_ui" {
  count                 = var.create_login_app ? 1 : 0
  client_id             = auth0_client.admin_ui[0].id
  authentication_method = "client_secret_post"
}

# Grant the client access to the API with consent skipped for first-party clients
resource "auth0_client_grant" "admin_ui_api_access" {
  count             = var.create_login_app ? 1 : 0
  client_id         = auth0_client.admin_ui[0].id
  audience          = var.api_identifier
  scopes            = []

  # Fresh tenants can return 404 until the API resource server is fully materialized.
  depends_on = [
    auth0_resource_server.api,
    auth0_resource_server_scopes.api_scopes
  ]
}

# Auth0 Resource Server (API) — tenant-wide, production only
resource "auth0_resource_server" "api" {
  count      = local.create_api_resource_server ? 1 : 0
  identifier = var.api_identifier
  name       = var.api_name
  skip_consent_for_verifiable_first_party_clients = true
}

# Define scopes for the API
resource "auth0_resource_server_scopes" "api_scopes" {
  count                      = local.create_api_resource_server ? 1 : 0
  resource_server_identifier = auth0_resource_server.api[0].identifier

  scopes {
    name        = "story:create"
    description = "Create stories"
  }

  scopes {
    name        = "story:update"
    description = "Update stories"
  }

  scopes {
    name        = "story:delete"
    description = "Delete stories"
  }

  scopes {
    name        = "subscribers:manage"
    description = "Manage subscribers"
  }

  scopes {
    name        = "tips:manage"
    description = "View and handle reader story tips"
  }
}

# Editor Role — tenant-wide, production only
resource "auth0_role" "editor" {
  count       = var.create_shared_resources ? 1 : 0
  name        = "editor"
  description = "Can create and update stories, upload media"
}

# Admin Role — tenant-wide, production only
resource "auth0_role" "admin" {
  count       = var.create_shared_resources ? 1 : 0
  name        = "admin"
  description = "Can manage all content, delete stories, manage subscribers"
}

# Editor role permissions
resource "auth0_role_permissions" "editor_permissions" {
  count   = var.create_shared_resources ? 1 : 0
  role_id = auth0_role.editor[0].id

  dynamic "permissions" {
    for_each = [
      "story:create",
      "story:update"
    ]
    content {
      name                       = permissions.value
      resource_server_identifier = auth0_resource_server.api[0].identifier
    }
  }

  depends_on = [auth0_resource_server_scopes.api_scopes]
}

# Admin role permissions (includes all)
resource "auth0_role_permissions" "admin_permissions" {
  count   = var.create_shared_resources ? 1 : 0
  role_id = auth0_role.admin[0].id

  dynamic "permissions" {
    for_each = [
      "story:create",
      "story:update",
      "story:delete",
      "subscribers:manage",
      "tips:manage"
    ]
    content {
      name                       = permissions.value
      resource_server_identifier = auth0_resource_server.api[0].identifier
    }
  }

  depends_on = [auth0_resource_server_scopes.api_scopes]
}

# Auth0 Action: Add roles to ID and access token on login
resource "auth0_action" "add_roles_to_token" {
  count   = var.create_shared_resources ? 1 : 0
  name    = "Add Roles to Token"
  runtime = "node18"
  deploy  = true

  supported_triggers {
    id      = "post-login"
    version = "v3"
  }

  code = <<-EOT
    /**
    * @param {Event} event - Details about the user and the context in which they are logging in.
    * @param {PostLoginAPI} api - Interface whose methods can be used to change the behavior of the login.
    */
    exports.onExecutePostLogin = async (event, api) => {
      const namespace = '${trimsuffix(var.roles_claim_namespace, "/")}';
      if (event.authorization) {
        api.idToken.setCustomClaim(`$${namespace}/roles`, event.authorization.roles);
        api.accessToken.setCustomClaim(`$${namespace}/roles`, event.authorization.roles);
      }
    }
  EOT
}

# Bind the action to the Post-Login trigger
resource "auth0_trigger_actions" "login_flow" {
  count   = var.create_shared_resources ? 1 : 0
  trigger = "post-login"

  actions {
    id           = auth0_action.add_roles_to_token[0].id
    display_name = auth0_action.add_roles_to_token[0].name
  }

  depends_on = [auth0_action.add_roles_to_token]
}
