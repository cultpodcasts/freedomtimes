terraform {
  required_version = ">= 1.6.0"

  cloud {
    organization = "freedomtimes"

    workspaces {
      name = "freedomtimes-auth0-shared"
    }
  }

  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.0"
    }
  }
}
