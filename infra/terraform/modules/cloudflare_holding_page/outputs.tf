output "worker_name" {
  description = "Worker script name"
  value       = cloudflare_workers_script.holding_page.name
}

output "route_pattern" {
  description = "Worker route pattern"
  value       = var.route_pattern
}
