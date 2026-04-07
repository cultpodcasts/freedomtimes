variable "account_id" {
  description = "Cloudflare account ID hosting the worker"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID for the domain"
  type        = string
}

variable "worker_name" {
  description = "Worker script name"
  type        = string
}

variable "route_pattern" {
  description = "Route pattern to attach worker to, e.g. freedomtimes.com/*"
  type        = string
}

variable "manage_apex_dns_record" {
  description = "Whether to create an apex DNS record in Cloudflare for custom-domain routing"
  type        = bool
  default     = false
}

variable "apex_dns_record_content" {
  description = "Content for apex A record when manage_apex_dns_record is enabled"
  type        = string
  default     = "192.0.2.1"
}

variable "holding_title" {
  description = "Holding page HTML title"
  type        = string
  default     = "Freedom Times"
}

variable "holding_heading" {
  description = "Main heading shown on the holding page"
  type        = string
  default     = "Freedom Times"
}

variable "holding_message" {
  description = "Message shown on the holding page"
  type        = string
  default     = "We are preparing the site. Please check back soon."
}

variable "build_revision" {
  description = "Optional build revision shown on the holding page"
  type        = string
  default     = ""
}

variable "contact_email" {
  description = "Optional contact email shown on the holding page"
  type        = string
  default     = ""
}

variable "worker_secrets" {
  description = "Map of Worker secret name to secret value for this script"
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "hyperdrive_config_id" {
  description = "Optional Hyperdrive config ID to bind as HYPERDRIVE on the Worker"
  type        = string
  default     = ""
}
