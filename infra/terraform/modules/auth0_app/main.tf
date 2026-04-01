# Auth0 Client (Regular Web App for server-side code exchange)
resource "auth0_client" "admin_ui" {
  name            = var.app_name
  app_type        = "regular_web"

  callbacks             = ["${var.workspace_url}/auth/callback"]
  allowed_logout_urls   = [var.workspace_url]
  allowed_origins       = [var.workspace_url]
  web_origins           = [var.workspace_url]
  
  custom_login_page_on = false
  is_first_party       = true

  jwt_configuration {
    lifetime_in_seconds = 3600
    secret_encoded      = true
  }
}

# Auth0 Resource Server (API) — tenant-wide, production only
resource "auth0_resource_server" "api" {
  count      = var.create_shared_resources ? 1 : 0
  identifier = var.api_identifier
  name       = "freedomtimes-api"
}

# Define scopes for the API
resource "auth0_resource_server_scopes" "api_scopes" {
  count                      = var.create_shared_resources ? 1 : 0
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
      "subscribers:manage"
    ]
    content {
      name                       = permissions.value
      resource_server_identifier = auth0_resource_server.api[0].identifier
    }
  }

  depends_on = [auth0_resource_server_scopes.api_scopes]
}

# Grant the Action M2M app access to the Management API with read:users + read:roles
resource "auth0_client_grant" "action_management_api" {
  count     = var.create_shared_resources && var.auth0_action_client_id != "" ? 1 : 0
  client_id = var.auth0_action_client_id
  audience  = "https://${var.auth0_domain}/api/v2/"
  scopes    = ["read:users", "read:roles"]
}

# Auth0 Action: Add roles to ID token on login
resource "auth0_action" "add_roles_to_token" {
  count   = var.create_shared_resources && var.auth0_action_client_id != "" ? 1 : 0
  name    = "Add Roles to Token"
  runtime = "node18"
  deploy  = true
  
  supported_triggers {
    id      = "post-login"
    version = "v3"
  }
  
  code = <<-EOT
    const ManagementClient = require('auth0').ManagementClient;

    exports.onExecutePostLogin = async (event, api) => {
      // Get user's roles
      const management = new ManagementClient({
        domain: event.secrets.AUTH0_DOMAIN,
        clientId: event.secrets.AUTH0_ACTION_CLIENT_ID,
        clientSecret: event.secrets.AUTH0_ACTION_CLIENT_SECRET,
      });

      try {
        const roles = await management.users.getRoles({ id: event.user.user_id });
        const roleNames = roles.map(role => role.name);
        
        // Add roles to ID token
        api.idToken.setCustomClaim('roles', roleNames);
        
        // Also add to access token for API validation
        api.accessToken.setCustomClaim('roles', roleNames);
      } catch (error) {
        console.log('Error fetching roles:', error.message);
        // Don't fail login - just log the error
      }
    };
  EOT
  
  secrets {
    name  = "AUTH0_DOMAIN"
    value = var.auth0_domain
  }
  
  secrets {
    name  = "AUTH0_ACTION_CLIENT_ID"
    value = var.auth0_action_client_id
  }
  
  secrets {
    name  = "AUTH0_ACTION_CLIENT_SECRET"
    value = var.auth0_action_client_secret
  }
}

# Bind the action to the Post-Login trigger
resource "auth0_trigger_actions" "login_flow" {
  count   = var.create_shared_resources && var.auth0_action_client_id != "" ? 1 : 0
  trigger = "post-login"

  actions {
    id           = auth0_action.add_roles_to_token[0].id
    display_name = auth0_action.add_roles_to_token[0].name
  }

  depends_on = [auth0_action.add_roles_to_token]
}
