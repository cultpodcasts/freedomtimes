output "worker_name" {
  description = "Worker script name"
  value       = cloudflare_workers_script.holding_page.script_name
}

output "route_pattern" {
  description = "Worker route pattern"
  value       = var.route_pattern
}

output "page_views_dataset" {
  description = "Analytics Engine dataset name (SQL table id) for public page views"
  value       = var.page_views_dataset
}

output "page_views_binding_name" {
  description = "Worker Analytics Engine binding name for page views"
  value       = var.page_views_binding_name
}

output "send_email_binding_name" {
  description = "Worker send_email binding name (EmDash cloudflareEmail)"
  value       = var.enable_send_email ? var.send_email_binding_name : null
}
