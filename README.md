# freedomtimes

Source for Freedom Times website and infrastructure.

## Infrastructure as Code

Initial Terraform scaffolding for Cloudflare is available in [infra/terraform](infra/terraform).

Current first step:
- deploy a Cloudflare Worker based holding page via Terraform

Environment policy:
- local development can run without Terraform
- Terraform is used for managed infrastructure deployment (staging and production)

See [infra/terraform/README.md](infra/terraform/README.md) for setup and usage.

## Local Development Requirements

See [LOCAL_DEV_REQUIREMENTS.md](LOCAL_DEV_REQUIREMENTS.md). This is a living document and will be updated as tooling and project requirements evolve.

## Development Guardrails

See [DEVELOPMENT_GUARDRAILS.md](DEVELOPMENT_GUARDRAILS.md) for branch policy, ticket flow, and PR rules.
