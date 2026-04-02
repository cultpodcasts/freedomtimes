locals {
  hash = substr(md5("${var.project_name}-${var.environment}-${var.location}"), 0, 6)

  resource_group_name = coalesce(var.resource_group_name, "${var.project_name}-${var.environment}-rg")
  function_app_name   = coalesce(var.function_app_name, "${var.project_name}-editorial-api-${var.environment}")
  cosmos_account_name = coalesce(var.cosmos_account_name, "${var.project_name}-${var.environment}-${local.hash}")
  service_plan_name   = coalesce(var.service_plan_name, "${var.project_name}-func-${var.environment}")

  normalized_storage_name = lower(replace("${var.project_name}${var.environment}${local.hash}", "-", ""))
  storage_account_name    = coalesce(var.storage_account_name, substr(local.normalized_storage_name, 0, 24))
  storage_connection_string = "DefaultEndpointsProtocol=https;AccountName=${azurerm_storage_account.function.name};AccountKey=${azurerm_storage_account.function.primary_access_key};EndpointSuffix=core.windows.net"

  base_app_settings = {
    WEBSITES_ENABLE_APP_SERVICE_STORAGE = "false"
    COSMOSDB_DATABASE_NAME          = azurerm_cosmosdb_sql_database.editorial.name
    COSMOSDB_STORIES_CONTAINER      = azurerm_cosmosdb_sql_container.stories.name
    COSMOSDB_MEDIA_CONTAINER        = azurerm_cosmosdb_sql_container.media.name
    COSMOSDB_SUBSCRIBERS_CONTAINER  = azurerm_cosmosdb_sql_container.subscribers.name
    COSMOSDB_ENDPOINT               = azurerm_cosmosdb_account.editorial.endpoint
    COSMOSDB_CONNECTION_STRING      = azurerm_cosmosdb_account.editorial.primary_sql_connection_string
  }
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

  app_settings = local.base_app_settings
  https_only   = true
  tags         = var.tags
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
