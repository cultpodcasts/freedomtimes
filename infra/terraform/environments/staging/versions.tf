terraform {
  required_version = ">= 1.6.0"

   cloud {
     organization = "freedomtimes"
  
     workspaces {
       name = "freedomtimes-staging"
     }
   }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.0"
    }
    turso = {
      source  = "jpedroh/turso"
      version = "~> 1.2"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
}
