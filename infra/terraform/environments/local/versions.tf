terraform {
  required_version = ">= 1.6.0"

  # Local backend — no Terraform Cloud. State lives on disk and is gitignored.
  backend "local" {
    path = "terraform.tfstate"
  }

  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.0"
    }
  }
}
