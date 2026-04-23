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

## Content Operations

Staging-to-production CMS promotion runbook is in [web/CONTENT_PROMOTION_RUNBOOK.md](web/CONTENT_PROMOTION_RUNBOOK.md).

## Development Guardrails

See [DEVELOPMENT_GUARDRAILS.md](DEVELOPMENT_GUARDRAILS.md) for branch policy, ticket flow, and PR rules.

## Staging Auth Login Flow

Use this runbook when validating login behavior on staging at https://staging.freedomtimes.news.

Expected sequence:

1. GET /auth/login
2. Redirect to Auth0 authorize endpoint (Authorization Code flow, scope `openid`, API audience requested)
3. GET /auth/callback with code and state
4. Role check allows admin/editor
5. Redirect to GET /signed-in
6. Token verifies and page renders

Consent behavior:

- For first-party staging and production apps, Auth0 API consent is skipped by Terraform (`skip_consent_for_verifiable_first_party_clients = true`).
- Users should not see an Auth0 consent screen during normal login unless tenant settings or app/API mappings are changed.

Cookie names used by web auth:

- ft_session (HttpOnly id token)
- ft_access_token (HttpOnly API access token)
- ft_csrf (JS-readable CSRF token)

Stale-cookie protections currently implemented:

- Callback and logout clear both host-only and domain-scoped auth cookie variants.
- Signed-in clears auth cookies and redirects to /auth/login when session token is expired.
- Signed-in detects duplicate ft_session values in the Cookie header, clears auth cookies, and forces clean login.

Role denial behavior:

- If callback token verifies but required role claim is missing, user is redirected to /?denied=1 and auth cookies are cleared.

Live tail command for each test attempt:

```powershell
cd web
npx wrangler tail freedomtimes-holding-staging --format pretty
```

Report each attempt with:

- auth/login outcome
- auth/callback outcome
- signed-in outcome
- final redirect/result
- any token verification or role-check errors

Detailed web-auth documentation is in [web/README.md](web/README.md).
