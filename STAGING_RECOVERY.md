# Staging/Production Recovery Checklist

When you destroy and re-create a full environment (staging or production), you must perform these manual follow-up steps to restore all required secrets and application state:

## 1. Re-sync Cloudflare Worker secrets

Run:

    ./scripts/set-github-secrets.ps1 -SyncCloudflareWorkerSecrets

This sets required secrets (e.g., `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`) for both staging and production Workers.

**Important:** The Auth0 login application's client secret (`AUTH0_CLIENT_SECRET`/`AUTH0_LOGIN_APP_CLIENT_SECRET`) is NOT output by Terraform for security reasons. You must manually copy it from the Auth0 dashboard and add it to your `.env.staging` and `.env.production` files before running the sync script. This is required for a working login flow.

## 2. (If needed) Re-sync GitHub Actions secrets/variables

Run:

    ./scripts/set-github-secrets.ps1

Ensures all GitHub Actions secrets/variables are up to date from your `.env` files.

## 3. Redeploy the Astro Worker

Run:

    cd web
    npm run build
    npx wrangler deploy --config wrangler.jsonc --env staging

(Or use the production config for prod.)

## 4. Verify application health

- Test sign-in and API endpoints in the browser.
- Check Cloudflare Worker logs for missing env errors.

---

**Note:**
- These steps are required after any full environment teardown, as secrets and state are not automatically restored by Terraform or GitHub Actions.
- If you skip these, you may see 500 errors or missing environment variable errors in Cloudflare Worker logs.
