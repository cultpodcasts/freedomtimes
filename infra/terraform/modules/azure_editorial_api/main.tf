locals {
  hash = substr(md5("${var.project_name}-${var.environment}-${var.location}"), 0, 6)

  resource_group_name = coalesce(var.resource_group_name, "${var.project_name}-${var.environment}-rg")
  function_app_name   = coalesce(var.function_app_name, "${var.project_name}-editorial-api-${var.environment}")
  cosmos_account_name = coalesce(var.cosmos_account_name, "${var.project_name}-${var.environment}-${local.hash}")
  service_plan_name   = coalesce(var.service_plan_name, "${var.project_name}-func-${var.environment}")
  api_management_name = coalesce(var.api_management_name, "${var.project_name}-${var.environment}-apim-${local.hash}")

  normalized_storage_name = lower(replace("${var.project_name}${var.environment}${local.hash}", "-", ""))
  storage_account_name    = coalesce(var.storage_account_name, substr(local.normalized_storage_name, 0, 24))
  storage_connection_string = "DefaultEndpointsProtocol=https;AccountName=${azurerm_storage_account.function.name};AccountKey=${azurerm_storage_account.function.primary_access_key};EndpointSuffix=core.windows.net"

  auth0_issuer_url                  = startswith(var.auth0_domain, "https://") ? trimsuffix(var.auth0_domain, "/") : "https://${trimspace(var.auth0_domain)}"
  auth0_openid_configuration_url    = "${local.auth0_issuer_url}/.well-known/openid-configuration"
  easy_auth_enabled                 = var.enable_easy_auth && length(trimspace(var.auth0_domain)) > 0 && length(trimspace(var.auth0_editorial_client_id)) > 0
  api_gateway_policy_enabled        = var.enable_api_gateway_policy && local.easy_auth_enabled && length(trimspace(var.auth0_api_audience)) > 0
  apim_allowed_roles_xml            = join("\n", [for role in var.allowed_roles : "              <value>${role}</value>"])
  apim_required_claims_xml          = length(var.allowed_roles) > 0 ? format("          <required-claims>\n            <claim name=\"%s\" match=\"any\">\n%s\n            </claim>\n          </required-claims>", var.roles_claim, local.apim_allowed_roles_xml) : ""

  base_app_settings = {
    WEBSITES_ENABLE_APP_SERVICE_STORAGE = "false"
    COSMOSDB_DATABASE_NAME          = azurerm_cosmosdb_sql_database.editorial.name
    COSMOSDB_STORIES_CONTAINER      = azurerm_cosmosdb_sql_container.stories.name
    COSMOSDB_MEDIA_CONTAINER        = azurerm_cosmosdb_sql_container.media.name
    COSMOSDB_SUBSCRIBERS_CONTAINER  = azurerm_cosmosdb_sql_container.subscribers.name
    COSMOSDB_ENDPOINT               = azurerm_cosmosdb_account.editorial.endpoint
    COSMOSDB_CONNECTION_STRING      = azurerm_cosmosdb_account.editorial.primary_sql_connection_string
  }

  function_app_settings = local.base_app_settings
}

resource "azurerm_resource_group" "editorial" {
  name     = local.resource_group_name
  location = var.location
  tags     = var.tags
}

resource "azurerm_storage_account" "function" {
  name                     = local.storage_account_name
  resource_group_name      = azurerm_resource_group.editorial.name
  location                 = azurerm_resource_group.editorial.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  min_tls_version          = "TLS1_2"
  tags                     = var.tags
}

resource "azurerm_service_plan" "function" {
  name                = local.service_plan_name
  resource_group_name = azurerm_resource_group.editorial.name
  location            = azurerm_resource_group.editorial.location
  os_type             = "Linux"
  sku_name            = "FC1"
  tags                = var.tags
}

resource "azurerm_storage_container" "function_code" {
  name                  = "function-code"
  storage_account_id    = azurerm_storage_account.function.id
  container_access_type = "private"
}

resource "azurerm_function_app_flex_consumption" "editorial" {
  name                = local.function_app_name
  resource_group_name = azurerm_resource_group.editorial.name
  location            = azurerm_resource_group.editorial.location

  service_plan_id            = azurerm_service_plan.function.id
  storage_container_type     = "blobContainer"
  storage_container_endpoint = "${azurerm_storage_account.function.primary_blob_endpoint}${azurerm_storage_container.function_code.name}"
  storage_authentication_type = "StorageAccountConnectionString"
  storage_access_key          = local.storage_connection_string

  runtime_name    = "node"
  runtime_version = var.node_version

  site_config {}

  dynamic "auth_settings_v2" {
    for_each = local.easy_auth_enabled ? [1] : []
    content {
      auth_enabled           = true
      require_authentication = true
      require_https          = true
      unauthenticated_action = "Return401"

      custom_oidc_v2 {
        name                          = "auth0"
        client_id                     = var.auth0_editorial_client_id
        openid_configuration_endpoint = local.auth0_openid_configuration_url
        name_claim_type               = "name"
      }

      login {}
    }
  }

  app_settings = local.function_app_settings
  https_only   = true
  tags         = var.tags
}

resource "azurerm_api_management" "editorial" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  name                = local.api_management_name
  location            = azurerm_resource_group.editorial.location
  resource_group_name = azurerm_resource_group.editorial.name
  publisher_name      = var.api_management_publisher_name
  publisher_email     = var.api_management_publisher_email
  sku_name            = var.api_management_sku_name
  tags                = var.tags
}

resource "azurerm_api_management_api" "editorial" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  name                = var.api_management_api_name
  resource_group_name = azurerm_resource_group.editorial.name
  api_management_name = azurerm_api_management.editorial[0].name
  revision            = "1"

  display_name          = "Freedom Times Editorial API"
  path                  = var.api_management_api_path
  protocols             = ["https"]
  subscription_required = false
  service_url           = "https://${azurerm_function_app_flex_consumption.editorial.default_hostname}/api"
}

resource "azurerm_api_management_api_policy" "editorial" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  resource_group_name = azurerm_resource_group.editorial.name
  api_management_name = azurerm_api_management.editorial[0].name
  api_name            = azurerm_api_management_api.editorial[0].name

  xml_content = <<-XML
    <policies>
      <inbound>
        <base />
        <validate-jwt header-name="Authorization" require-scheme="Bearer" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized">
          <openid-config url="${local.auth0_openid_configuration_url}" />
          <audiences>
            <audience>${var.auth0_api_audience}</audience>
          </audiences>
${local.apim_required_claims_xml}
        </validate-jwt>
      </inbound>
      <backend>
        <base />
      </backend>
      <outbound>
        <base />
      </outbound>
      <on-error>
        <base />
      </on-error>
    </policies>
  XML
}

resource "azurerm_cosmosdb_account" "editorial" {
  name                = local.cosmos_account_name
  location            = azurerm_resource_group.editorial.location
  resource_group_name = azurerm_resource_group.editorial.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  consistency_policy {
    consistency_level = "Session"
  }

  capabilities {
    name = "EnableServerless"
  }

  geo_location {
    location          = azurerm_resource_group.editorial.location
    failover_priority = 0
  }

  tags = var.tags
}

resource "azurerm_cosmosdb_sql_database" "editorial" {
  name                = var.cosmos_database_name
  resource_group_name = azurerm_resource_group.editorial.name
  account_name        = azurerm_cosmosdb_account.editorial.name
}

resource "azurerm_cosmosdb_sql_container" "stories" {
  name                = var.stories_container_name
  resource_group_name = azurerm_resource_group.editorial.name
  account_name        = azurerm_cosmosdb_account.editorial.name
  database_name       = azurerm_cosmosdb_sql_database.editorial.name

  partition_key_paths = ["/pk"]
}

resource "azurerm_cosmosdb_sql_container" "media" {
  name                = var.media_container_name
  resource_group_name = azurerm_resource_group.editorial.name
  account_name        = azurerm_cosmosdb_account.editorial.name
  database_name       = azurerm_cosmosdb_sql_database.editorial.name

  partition_key_paths = ["/mediaType"]
}

resource "azurerm_cosmosdb_sql_container" "subscribers" {
  name                = var.subscribers_container_name
  resource_group_name = azurerm_resource_group.editorial.name
  account_name        = azurerm_cosmosdb_account.editorial.name
  database_name       = azurerm_cosmosdb_sql_database.editorial.name

  partition_key_paths = ["/email"]
}
