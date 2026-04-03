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
  api_gateway_policy_enabled        = var.enable_api_gateway_policy && length(trimspace(var.auth0_domain)) > 0 && length(trimspace(var.auth0_api_audience)) > 0
  api_gateway_diagnostics_enabled   = local.api_gateway_policy_enabled && var.enable_api_management_diagnostics
  apim_allowed_roles_xml            = join("\n", [for role in var.allowed_roles : "              <value>${role}</value>"])
  apim_allowed_audiences            = distinct(compact([var.auth0_api_audience, "${local.auth0_issuer_url}/userinfo"]))
  apim_allowed_audiences_xml        = join("\n", [for audience in local.apim_allowed_audiences : "            <audience>${audience}</audience>"])
  apim_allowed_origins_xml          = join("\n", [for origin in var.api_management_allowed_origins : "            <origin>${origin}</origin>"])
  apim_allowed_origins_condition    = length(var.api_management_allowed_origins) > 0 ? join(" || ", [for origin in var.api_management_allowed_origins : "context.Request.Headers.GetValueOrDefault(\"Origin\", \"\") == \"${origin}\""]) : "false"
  apim_required_claims_xml          = length(var.allowed_roles) > 0 ? format("          <required-claims>\n            <claim name=\"%s\" match=\"any\">\n%s\n            </claim>\n          </required-claims>", var.roles_claim, local.apim_allowed_roles_xml) : ""
  apim_gateway_custom_domain_enabled = var.manage_api_management_gateway_custom_domain && local.api_gateway_policy_enabled && length(trimspace(var.api_management_gateway_custom_domain)) > 0 && length(trimspace(var.api_management_gateway_certificate_base64)) > 0 && length(trimspace(var.api_management_gateway_certificate_password)) > 0

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

resource "azurerm_log_analytics_workspace" "editorial" {
  name                = "${var.project_name}-${var.environment}-law-${local.hash}"
  location            = azurerm_resource_group.editorial.location
  resource_group_name = azurerm_resource_group.editorial.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_analytics_retention_in_days
  tags                = var.tags
}

resource "azurerm_application_insights" "editorial" {
  name                = "${var.project_name}-${var.environment}-appi-${local.hash}"
  location            = azurerm_resource_group.editorial.location
  resource_group_name = azurerm_resource_group.editorial.name
  workspace_id        = azurerm_log_analytics_workspace.editorial.id
  application_type    = "web"
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

  site_config {
    application_insights_connection_string = azurerm_application_insights.editorial.connection_string
    application_insights_key               = azurerm_application_insights.editorial.instrumentation_key
  }

  app_settings = local.function_app_settings
  https_only   = true
  tags         = var.tags

  # Azure API/provider returns this value differently for Flex Consumption,
  # causing perpetual non-functional plan churn.
  lifecycle {
    ignore_changes = [
      storage_access_key,
    ]
  }
}

  # --- Fetch the default function key for the Function App ---
  data "azurerm_function_app_host_keys" "editorial" {
    name                = azurerm_function_app_flex_consumption.editorial.name
    resource_group_name = azurerm_resource_group.editorial.name
    depends_on = [azurerm_function_app_flex_consumption.editorial]
  }

  # --- Create APIM Named Value for the Function Key ---
  resource "azurerm_api_management_named_value" "function_key" {
    count               = local.api_gateway_policy_enabled ? 1 : 0
    name                = "editorial-function-key"
    resource_group_name = azurerm_resource_group.editorial.name
    api_management_name = azurerm_api_management.editorial[0].name
    display_name        = "editorial-function-key"
    value               = data.azurerm_function_app_host_keys.editorial.default_function_key
    secret              = true
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

resource "azurerm_api_management_api_operation" "stories_get" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  operation_id        = "stories-get"
  api_name            = azurerm_api_management_api.editorial[0].name
  api_management_name = azurerm_api_management.editorial[0].name
  resource_group_name = azurerm_resource_group.editorial.name
  method              = "GET"
  url_template        = "/stories"
  display_name        = "Get Stories"
}

resource "azurerm_api_management_api_operation" "stories_search_get" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  operation_id        = "stories-search-get"
  api_name            = azurerm_api_management_api.editorial[0].name
  api_management_name = azurerm_api_management.editorial[0].name
  resource_group_name = azurerm_resource_group.editorial.name
  method              = "GET"
  url_template        = "/stories/search"
  display_name        = "Search Stories"
}

resource "azurerm_api_management_api_operation" "story_by_id_get" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  operation_id        = "story-by-id-get"
  api_name            = azurerm_api_management_api.editorial[0].name
  api_management_name = azurerm_api_management.editorial[0].name
  resource_group_name = azurerm_resource_group.editorial.name
  method              = "GET"
  url_template        = "/stories/{id}"
  display_name        = "Get Story By ID"

  template_parameter {
    name        = "id"
    required    = true
    type        = "string"
    description = "Story identifier"
  }
}

resource "azurerm_api_management_api_operation" "health_get" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  operation_id        = "health-get"
  api_name            = azurerm_api_management_api.editorial[0].name
  api_management_name = azurerm_api_management.editorial[0].name
  resource_group_name = azurerm_resource_group.editorial.name
  method              = "GET"
  url_template        = "/health"
  display_name        = "Health"
}

resource "azurerm_api_management_custom_domain" "editorial" {
  count = local.apim_gateway_custom_domain_enabled ? 1 : 0

  api_management_id = azurerm_api_management.editorial[0].id

  gateway {
    host_name            = trimspace(var.api_management_gateway_custom_domain)
    certificate          = trimspace(var.api_management_gateway_certificate_base64)
    certificate_password = trimspace(var.api_management_gateway_certificate_password)
  }
}

resource "azurerm_api_management_logger" "application_insights" {
  count = local.api_gateway_diagnostics_enabled ? 1 : 0

  name                = "appinsights"
  resource_group_name = azurerm_resource_group.editorial.name
  api_management_name = azurerm_api_management.editorial[0].name

  application_insights {
    instrumentation_key = azurerm_application_insights.editorial.instrumentation_key
  }
}

resource "azurerm_api_management_api_diagnostic" "editorial" {
  count = local.api_gateway_diagnostics_enabled ? 1 : 0

  resource_group_name      = azurerm_resource_group.editorial.name
  api_management_name      = azurerm_api_management.editorial[0].name
  api_name                 = azurerm_api_management_api.editorial[0].name
  identifier               = "applicationinsights"
  api_management_logger_id = azurerm_api_management_logger.application_insights[0].id

  sampling_percentage       = 100.0
  always_log_errors         = true
  log_client_ip             = true
  verbosity                 = "information"
  http_correlation_protocol = "W3C"

  frontend_request {
    body_bytes = 0
    headers_to_log = [
      "x-correlation-id",
      "x-forwarded-for",
      "user-agent",
    ]
  }

  frontend_response {
    body_bytes = 0
    headers_to_log = [
      "x-correlation-id",
    ]
  }

  backend_request {
    body_bytes = 0
    headers_to_log = [
      "x-correlation-id",
    ]
  }

  backend_response {
    body_bytes = 0
    headers_to_log = [
      "x-correlation-id",
    ]
  }
}

resource "azurerm_api_management_api_policy" "editorial" {
  count = local.api_gateway_policy_enabled ? 1 : 0

  resource_group_name = azurerm_resource_group.editorial.name
  api_management_name = azurerm_api_management.editorial[0].name
  api_name            = azurerm_api_management_api.editorial[0].name

  depends_on = [
    azurerm_api_management_named_value.function_key,
    azurerm_api_management_api_operation.stories_get,
    azurerm_api_management_api_operation.stories_search_get,
    azurerm_api_management_api_operation.story_by_id_get,
    azurerm_api_management_api_operation.health_get,
  ]

  xml_content = <<-XML
    <policies>
      <inbound>
        <base />
        <!-- Enable credentialed CORS -->
        <cors allow-credentials="true">
          <allowed-origins>
${local.apim_allowed_origins_xml}
          </allowed-origins>
          <allowed-methods>
            <method>GET</method>
            <method>POST</method>
            <method>PUT</method>
            <method>PATCH</method>
            <method>DELETE</method>
            <method>OPTIONS</method>
          </allowed-methods>
          <allowed-headers>
            <header>Authorization</header>
            <header>Content-Type</header>
            <header>X-CSRF-Token</header>
            <header>X-Correlation-ID</header>
          </allowed-headers>
          <expose-headers>
            <header>Content-Type</header>
            <header>X-Correlation-ID</header>
          </expose-headers>
        </cors>

        <!-- Propagate client-supplied correlation id end to end -->
        <set-variable name="correlationId" value="@(context.Request.Headers.GetValueOrDefault(&quot;X-Correlation-ID&quot;, &quot;&quot;))" />
        <set-variable name="isWorkerProxyRequest" value="@(context.Request.Headers.GetValueOrDefault(&quot;X-FT-Proxy&quot;, &quot;&quot;) == &quot;1&quot;)" />
        <choose>
          <when condition="@(!string.IsNullOrEmpty((string)context.Variables[&quot;correlationId&quot;]))">
            <set-header name="X-Correlation-ID" exists-action="override">
              <value>@((string)context.Variables[&quot;correlationId&quot;])</value>
            </set-header>
          </when>
        </choose>

        <!-- Remove inbound Authorization only for browser-originated, non-proxy requests. -->
        <choose>
          <when condition="@(!(bool)context.Variables[&quot;isWorkerProxyRequest&quot;] &amp;&amp; !string.IsNullOrEmpty(context.Request.Headers.GetValueOrDefault(&quot;Origin&quot;, &quot;&quot;)))">
            <set-header name="Authorization" exists-action="delete" />
          </when>
        </choose>

        <choose>
          <when condition="@(!(bool)context.Variables[&quot;isWorkerProxyRequest&quot;])">
            <!-- Parse cookie values in APIM expression-safe form -->
            <set-variable name="cookieHeader" value="@(context.Request.Headers.GetValueOrDefault(&quot;Cookie&quot;, &quot;&quot;))" />
            <set-variable name="accessTokenFromCookie" value="@{
              var cookie = (string)context.Variables[&quot;cookieHeader&quot;];
              var marker = &quot;ft_access_token=&quot;;
              var start = cookie.IndexOf(marker);
              if (start < 0) { return &quot;&quot;; }
              start += marker.Length;
              var end = cookie.IndexOf(&quot;;&quot;, start);
              return (end < 0 ? cookie.Substring(start) : cookie.Substring(start, end - start)).Trim();
            }" />
            <set-variable name="csrfTokenFromCookie" value="@{
              var cookie = (string)context.Variables[&quot;cookieHeader&quot;];
              var marker = &quot;ft_csrf=&quot;;
              var start = cookie.IndexOf(marker);
              if (start < 0) { return &quot;&quot;; }
              start += marker.Length;
              var end = cookie.IndexOf(&quot;;&quot;, start);
              return (end < 0 ? cookie.Substring(start) : cookie.Substring(start, end - start)).Trim();
            }" />
            <set-variable name="csrfTokenFromHeader" value="@(context.Request.Headers.GetValueOrDefault(&quot;X-CSRF-Token&quot;, &quot;&quot;))" />

            <!-- Extract JWT from cookie and set Authorization header for upstream -->
            <choose>
              <when condition="@(!string.IsNullOrEmpty((string)context.Variables[&quot;accessTokenFromCookie&quot;]))">
                <set-header name="Authorization" exists-action="override">
                  <value>@(&quot;Bearer &quot; + (string)context.Variables[&quot;accessTokenFromCookie&quot;])</value>
                </set-header>
              </when>
            </choose>

            <!-- Enforce CSRF for state-changing methods when using cookie auth -->
            <choose>
              <when condition="@(context.Request.Method == &quot;POST&quot; || context.Request.Method == &quot;PUT&quot; || context.Request.Method == &quot;PATCH&quot; || context.Request.Method == &quot;DELETE&quot;)">
                <choose>
                  <when condition="@(string.IsNullOrEmpty((string)context.Variables[&quot;csrfTokenFromCookie&quot;]) || string.IsNullOrEmpty((string)context.Variables[&quot;csrfTokenFromHeader&quot;]) || (string)context.Variables[&quot;csrfTokenFromCookie&quot;] != (string)context.Variables[&quot;csrfTokenFromHeader&quot;])">
                    <return-response>
                      <set-status code="403" reason="Forbidden" />
                      <set-body>CSRF token missing or invalid.</set-body>
                    </return-response>
                  </when>
                </choose>
              </when>
            </choose>

            <validate-jwt header-name="Authorization" require-scheme="Bearer" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized">
              <openid-config url="${local.auth0_openid_configuration_url}" />
              <audiences>
${local.apim_allowed_audiences_xml}
              </audiences>
${local.apim_required_claims_xml}
            </validate-jwt>
          </when>
        </choose>

        <!-- Inject Azure Function key for backend call -->
        <set-header name="x-functions-key" exists-action="override">
          <value>{{editorial-function-key}}</value>
        </set-header>
      </inbound>
      <backend>
        <base />
      </backend>
      <outbound>
        <base />
        <choose>
          <when condition="@(${local.apim_allowed_origins_condition})">
            <set-header name="Access-Control-Allow-Origin" exists-action="override">
              <value>@(context.Request.Headers.GetValueOrDefault(&quot;Origin&quot;, &quot;&quot;))</value>
            </set-header>
            <set-header name="Access-Control-Allow-Credentials" exists-action="override">
              <value>true</value>
            </set-header>
            <set-header name="Access-Control-Expose-Headers" exists-action="override">
              <value>Content-Type, X-Correlation-ID</value>
            </set-header>
            <set-header name="Vary" exists-action="append">
              <value>Origin</value>
            </set-header>
          </when>
        </choose>
        <choose>
          <when condition="@(!string.IsNullOrEmpty(context.Request.Headers.GetValueOrDefault(&quot;X-Correlation-ID&quot;, &quot;&quot;)))">
            <set-header name="X-Correlation-ID" exists-action="override">
              <value>@(context.Request.Headers.GetValueOrDefault(&quot;X-Correlation-ID&quot;, &quot;&quot;))</value>
            </set-header>
          </when>
        </choose>
      </outbound>
      <on-error>
        <base />
        <choose>
          <when condition="@(${local.apim_allowed_origins_condition})">
            <set-header name="Access-Control-Allow-Origin" exists-action="override">
              <value>@(context.Request.Headers.GetValueOrDefault(&quot;Origin&quot;, &quot;&quot;))</value>
            </set-header>
            <set-header name="Access-Control-Allow-Credentials" exists-action="override">
              <value>true</value>
            </set-header>
            <set-header name="Access-Control-Expose-Headers" exists-action="override">
              <value>Content-Type, X-Correlation-ID</value>
            </set-header>
            <set-header name="Vary" exists-action="append">
              <value>Origin</value>
            </set-header>
          </when>
        </choose>
        <choose>
          <when condition="@(!string.IsNullOrEmpty(context.Request.Headers.GetValueOrDefault(&quot;X-Correlation-ID&quot;, &quot;&quot;)))">
            <set-header name="X-Correlation-ID" exists-action="override">
              <value>@(context.Request.Headers.GetValueOrDefault(&quot;X-Correlation-ID&quot;, &quot;&quot;))</value>
            </set-header>
          </when>
        </choose>
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
