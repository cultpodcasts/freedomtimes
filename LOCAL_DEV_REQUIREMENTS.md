# Local Development Requirements

This is a living checklist for setting up and validating local development for Freedom Times.

## Core Tools

- Git
- GitHub CLI (`gh`) with access to this repository
- Terraform CLI (for IaC deployment workflows)
- A code editor (VS Code recommended)

## Verified in This Workspace

- Terraform: `v1.14.8` (`terraform -version`)

## GitHub Access

- Authenticate with an account that has repository, PR, and project board access:
  - `gh auth login -h github.com`
  - `gh auth status`
- Required scopes as of now:
  - `repo`
  - `read:org`
  - `project` (includes read/write project operations)

## Terraform Workflow (Current)

Note: local application development does not need Terraform. Use Terraform when planning/applying managed infrastructure for production or staging.

Terraform structure currently exists at:
- `infra/terraform/modules/cloudflare_holding_page`
- `infra/terraform/environments/production`
- `infra/terraform/environments/staging`

For infrastructure planning/apply:

1. Change directory:
   - production: `cd infra/terraform/environments/production`
   - staging: `cd infra/terraform/environments/staging`
2. Use `terraform.tfvars.example` as a placeholder template only (do not place real secrets in examples)
3. Set required variables in shell (PowerShell):
   - `$env:TF_VAR_cloudflare_api_token = "<token>"`
   - `$env:TF_VAR_cloudflare_account_id = "<account-id>"`
   - `$env:TF_VAR_cloudflare_zone_id = "<zone-id>"`
   - `$env:TF_VAR_route_pattern = "example.com/*"`
4. Run Terraform:
   - `terraform init`
   - `terraform plan`
   - `terraform apply`

Local automation helpers (recommended):

- Validate environment and provider credentials:
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-preflight.ps1 -Environment staging -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-preflight.ps1 -Environment production -LoadEnvFiles`
- Run Terraform non-interactively:
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation init -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation plan -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles`
   - `powershell -ExecutionPolicy Bypass -File ./scripts/terraform-run.ps1 -Environment staging -Operation destroy -LoadEnvFiles -AutoApprove`

Notes:

- `terraform-run.ps1` uses `-input=false` and lock timeout flags automatically.
- `apply` uses `tfplan` when present; otherwise pass `-AutoApprove` for direct apply.
- `destroy` requires `-AutoApprove` to avoid interactive prompts.

## Security Rules

- Do not store secrets in tfvars files.
- Keep `terraform.tfvars.example` files placeholder-only; never put actual environment values in examples.
- Never hardcode API tokens in `.tf` files or docs.
- Use least-privilege Cloudflare tokens.

## Cloudflare Token Permissions (Track This)

Current required permissions for `TF_VAR_cloudflare_api_token`:

- Account: `Workers Scripts: Edit`
- Zone: `Workers Routes: Edit`
- Zone: `Zone: Read`

Scope the token to the specific Freedom Times account and zone only.

If Terraform resources change later (for example DNS records, KV namespace management, cache operations), update this section before expanding token permissions.

## Next Items to Add Here

- Node.js and package manager version requirements (once app code is added)
- Wrangler CLI requirement and version
- Auth0 local integration requirements
- Any required VS Code extensions
- CI parity commands for local preflight checks

## Android Local Build and Push Requirements

Use this section when validating Android push notifications locally for the Capacitor app.

### Required Tooling

- OpenJDK 21 installed locally.
- Android SDK installed with:
  - Platform: `android-36`
  - Build Tools: `35.0.0` (minimum needed by current Gradle build)
- Node dependencies installed in `web/`.

### Java Setup (PowerShell)

If Java is installed but not on PATH in your current terminal, set it before running Gradle:

```powershell
$env:JAVA_HOME='C:\Program Files\Android\openjdk\jdk-21.0.8'
$env:Path="$env:JAVA_HOME\bin;$env:Path"
java -version
```

Adjust the path if your JDK is installed elsewhere.

### Android SDK Path Configuration

Create `web/android/local.properties` with your local SDK path:

```properties
sdk.dir=C\:\\Users\\<your-user>\\.bubblewrap\\android_sdk
```

Notes:
- `local.properties` is local-only and already ignored by git.
- If you keep your SDK under Program Files, Gradle may fail to install missing components due to permissions.

### Firebase Android Config for Push

Place Firebase Android config at:

- `web/android/app/google-services.json`

For this repository, a local source copy exists at `secrets/google-services.json`.

Security note:
- `web/android/app/google-services.json` is gitignored.
- Keep secret/config source files under `secrets/` only; never commit them.

### Sync and Build Commands

From repository root:

```powershell
npx cap sync android --project web
.\web\android\gradlew.bat -p .\web\android assembleDebug
```

Expected result:
- `BUILD SUCCESSFUL`

If build fails with `SDK location not found`, re-check `web/android/local.properties`.
If build fails with `java not recognized`, re-check `JAVA_HOME` and PATH for the active shell.

---
## Restoring and Syncing Auth0 Client ID for Staging

To ensure the Cloudflare Worker and web app can authenticate with Auth0 after a full environment teardown or redeploy, follow this process to restore and sync the Auth0 login app client ID:

### 1. Ensure Terraform State and Outputs Exist
- Navigate to the staging environment directory:
  ```sh
  cd infra/terraform/environments/staging
  ```
- Initialize Terraform if needed:
  ```sh
  terraform init
  ```
- Apply the configuration to create/update state and outputs:
  ```sh
  terraform apply -auto-approve
  ```
  This will create the state file and output the `auth0_app_client_id`.

### 2. Fetch the Auth0 Client ID
- Run:
  ```sh
  terraform output -raw auth0_app_client_id
  ```
- Copy the output value (should start with `DtpB...`).

### 3. Update `.env.staging`
- Open `.env.staging` in the repo root.
- Set the value for `AUTH0_LOGIN_APP_CLIENT_ID` to the value from Terraform output:
  ```env
  AUTH0_LOGIN_APP_CLIENT_ID=<value from terraform output>
  ```

### 4. Sync Secrets to Cloudflare Worker (if needed)
- Run the sync script:
  ```sh
  pwsh ./scripts/set-github-secrets.ps1
  ```
- This will push the updated secrets to GitHub Actions/Cloudflare as needed.

### Troubleshooting
- If `terraform output -raw auth0_app_client_id` returns nothing:
  - Ensure you have run `terraform apply` and the state file exists.
  - Check that `outputs.tf` defines the correct output.
- If the client ID in Auth0 dashboard does not match, check for manual changes or drift.

### Automation
- This process can be scripted for CI/CD or local automation, but always verify the value matches the Auth0 dashboard after a full teardown.

---
## Reconciling and Syncing Staging Cloudflare Worker Secrets

If Cloudflare Worker secrets for staging (such as Auth0 credentials) are missing or out of sync, follow these steps to restore and reconcile them using the sync script:

### 1. Ensure `.env.staging` is Up to Date
- Confirm that `.env.staging` contains the correct values for:
  - `AUTH0_LOGIN_APP_CLIENT_ID`
  - `AUTH0_LOGIN_APP_CLIENT_SECRET`
  - `AUTH0_DOMAIN`
- These values are used to set the corresponding Worker secrets.

### 2. Run the Sync Script with Cloudflare Option
- From the repo root, run:
  ```sh
  pwsh ./scripts/set-github-secrets.ps1 -SyncCloudflareWorkerSecrets -Target Staging
  ```
- This will:
  - Read `.env.staging` and overlay it on `.env.dev`.
  - Push the following secrets to the staging Worker (via wrangler.jsonc):
    - `AUTH0_DOMAIN`
    - `AUTH0_CLIENT_ID` (from `AUTH0_LOGIN_APP_CLIENT_ID`)
    - `AUTH0_CLIENT_SECRET` (from `AUTH0_LOGIN_APP_CLIENT_SECRET`)

### 3. Verification
- You can verify the secrets are set by running:
  ```sh
  npx wrangler secret list --config web/wrangler.jsonc --env staging
  ```
- Or by checking the Cloudflare dashboard for the Worker.

### 4. Troubleshooting
- If secrets are missing after running the script:
  - Ensure `.env.staging` has the correct, non-empty values.
  - Ensure you have permissions to update Worker secrets.
  - Check for errors in the script output.
- If you need to force a refresh, you can delete and re-add secrets using Wrangler CLI.

### 5. Notes
- The sync script can also update GitHub Actions secrets/variables if run without the `-SyncCloudflareWorkerSecrets` flag.
- For production, use `-Target Production` and ensure `.env.production` is correct.
