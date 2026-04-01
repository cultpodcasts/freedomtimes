terraform {
  required_version = ">= 1.6.0"

  cloud {
    organization = "freedomtimes"

    workspaces {
      name = "freedomtimes-production"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}
