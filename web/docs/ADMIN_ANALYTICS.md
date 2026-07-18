# Site analytics — public page views (Cloudflare Analytics Engine)

Freedom Times **site analytics**: page views of **public reader routes** (homepage, articles, other public HTML pages), displayed on the locked-down staff page at `/admin/analytics` (linked from the `/admin` hub tile **Site traffic**).

This is **not** analytics of the admin UI, tip desks, or other staff tools. `/admin/analytics` is the **viewer**.

**Backend only** — no frontend pixels or third-party trackers.

## What it shows

On `/admin/analytics` (Auth0 `admin` role), **Site traffic / Public page views**:

| Metric | Notes |
|--------|--------|
| Top public pages | Paths ranked by approximate view count (e.g. `/`, `/posts/{slug}`, `/{page-slug}`). Click a path to drill into countries for that page. |
| By country | Site-wide countries from Cloudflare edge (`cf.country`); UI shows flag + English name (ISO code in tooltip) |
| Page × country | When `?path=` is set (or a top page is selected), the **same** country panel swaps to that path’s breakdown (no third table) |
| Layout | Desktop/tablet: pages left, countries right. Mobile: Pages \| Countries segmented control; selecting a path opens Countries with ← Pages |
| Timeframes | `1d` (1 day), `1w` (7 days), `1m` (30 days) |
| Bots | Flagged on write; **hidden by default** on `/admin/analytics` (`?includeBots=1` to include) |

JSON API (same auth as other `/api/admin/*` routes):

`GET /api/admin/analytics?range=1d|1w|1m&includeBots=1&path=/posts/example`

## What is counted vs excluded

### Counted (subjects of the stats)

Successful **GET** responses that return **HTML** (`2xx`) for public reader paths, including:

| Path pattern | Meaning |
|--------------|---------|
| `/` | Public homepage (**production** canonical; `index.astro` rewrites to newsroom) |
| `/homepage` | Newsroom home (**locked staging** canonical). On production, direct `/homepage` hits are **aliased to `/`** in analytics (same page) |
| `/posts/{slug}` | Article / post |
| `/{slug}` | CMS page (EmDash `pages` or fallback post lookup) |
| `/archives`, `/archives/{slug}` | Archives |
| `/submit-a-tip`, `/tip-source` | Public reader HTML utilities |

Article identity is the request pathname (e.g. `/posts/weekly-summary-13-july-2026`) — query strings and hashes are stripped; trailing slashes normalized. Homepage aliases (`/` ↔ `/homepage`) are collapsed to `getHomePath()` on write. On production read, historical `/homepage` rows are merged into `/` in application code (Analytics Engine SQL does not support `CASE WHEN`). Locked staging keeps `/homepage` as the Top pages key.

### Excluded (never written)

| Path / condition | Why |
|------------------|-----|
| `/admin`, `/admin/*` | Staff hub and tools are viewers, not public pages |
| `/api/*` | APIs, not HTML pages |
| `/_emdash*`, `/.well-known/*` | EmDash / OAuth internals |
| `/auth/*`, `/signed-in`, `/authorize` | Auth utilities |
| `/_astro/*`, static assets, robots/sitemap, service worker | Non-content |
| Staging locked `/` | Auth0 login wall (not the public newsroom) |
| Non-GET, redirects (`3xx`), errors (`4xx`/`5xx`) | Not successful page views |
| `DNT: 1` | Honour Do Not Track |
| Non-HTML `Accept` / `Content-Type` | Assets and JSON probes |

Bots are still **written** with `blob3 = '1'` so staff can optionally include them; the `/admin/analytics` UI defaults to **human-only** (`blob3 = '0'`).

## Privacy / GDPR posture

Aligned with `ARCHITECTURE.md` §4.13.

| Topic | Choice |
|-------|--------|
| Lawful basis | Legitimate interest in operating the journalism platform (public site traffic metrics) |
| What is stored | Aggregate counters only: path, ISO country, bot flag (`0`/`1`) |
| What is **not** stored | IP addresses, cookies, full User-Agent strings, session IDs, device fingerprints, JA3 hashes, user profiles |
| Frontend | No tracking pixels, no analytics SDKs, no non-essential analytics cookies |
| Bot signals | Classified at request time from `cf.botManagement` when available; otherwise ephemeral User-Agent heuristics — UA is **never** written to Analytics Engine |
| DNT | Writes skipped when `DNT: 1` |
| Retention | Workers Analytics Engine retains data ~**3 months** (Cloudflare platform). Prefer AE over app-layer request logs for minimization |
| Safer alternative chosen | Analytics Engine aggregates instead of GraphQL zone analytics (weaker path control) or Turso hit logs (long-lived, easier to over-collect) |

Reader-facing disclosure: keep the EmDash `/privacy-policy` page consistent with §4.13 (aggregates + coarse country; no profiling). Update that page if operators want an explicit “edge metrics” sentence.

## How ingest works

Middleware (`web/src/middleware.ts`) records eligible public HTML GET responses via `recordPageView()` after `next()`:

```text
blob1 = path          (e.g. /posts/my-article)
blob2 = country       (or XX)
blob3 = is_bot        ("0" | "1")
double1 = 1
index1 = path         (sampling key)
```

### Bot flag

1. If `request.cf.botManagement` is present: treat as bot when `verifiedBot` is true, or `score` is in `(0, 30)`.
2. Else: User-Agent heuristics (empty/short UA, known crawler tokens) — inspected only in memory.

Bot Management scores need the Cloudflare Bot Management product; without it, UA heuristics still run. Admin UI excludes `blob3 = '1'` by default.

## Ownership: Terraform vs Wrangler

There is **no separate Cloudflare “create dataset” API**. The Analytics Engine **dataset name** is the SQL table id. Terraform is the source of truth for that id and the Worker binding identity.

| Piece | Owner |
|-------|--------|
| Dataset name / “analytics id” | **Terraform** (`var.page_views_dataset` → output `page_views_dataset`) |
| Worker binding `PAGE_VIEWS` → dataset | **Terraform** (`analytics_engine_binding` on `cloudflare_workers_script`) |
| Worker secret `CLOUDFLARE_ANALYTICS_API_TOKEN` | **Terraform** (`worker_secrets` from required `ANALYTICS_CF_TOKEN`) |
| Wrangler vars `CLOUDFLARE_ACCOUNT_ID`, `PAGE_VIEWS_DATASET` | **Wrangler** — dataset var must **match** Terraform output `page_views_dataset` (do not also create same-named secrets) |

### Read the analytics id

```powershell
pwsh scripts/terraform-run.ps1 -Environment staging -Operation output -LoadEnvFiles
# or directly:
terraform -chdir=infra/terraform/environments/staging output -raw page_views_dataset
```

| Environment | Default dataset id (`page_views_dataset`) |
|-------------|-------------------------------------------|
| staging | `freedomtimes_staging_page_views` |
| production | `freedomtimes_page_views` |
| local wrangler | `freedomtimes_page_views_local` (not in Terraform) |

Do **not** invent ad-hoc dataset names in Wrangler or mint a parallel “analytics id” by hand.

## Configuration checklist

### 1. Terraform apply (dataset + secrets)

```powershell
pwsh scripts/terraform-run.ps1 -Environment staging -Operation apply -LoadEnvFiles
```

That:

1. Declares `analytics_engine_binding` name `PAGE_VIEWS` → dataset from `var.page_views_dataset`
2. Pushes Worker secret `CLOUDFLARE_ANALYTICS_API_TOKEN` from required `ANALYTICS_CF_TOKEN` / `var.cloudflare_analytics_api_token`
3. Exposes outputs `page_views_dataset` and `page_views_binding_name`

`CLOUDFLARE_ACCOUNT_ID` and `PAGE_VIEWS_DATASET` are **Wrangler env vars** (see `web/wrangler.jsonc`); they must match the Terraform dataset output. Do not also create same-named Worker secrets — Cloudflare bindings cannot share a name between vars and secrets.

The CF dataset table itself materialises on **first write** after the binding exists (Cloudflare platform behaviour).

### 2. Query auth (operator-provided Account Analytics Read token)

Admin charts call the **Analytics Engine SQL API** (`POST /accounts/{account_id}/analytics_engine/sql`) — not GraphQL Account Analytics dashboards.

| Name | Source | Purpose |
|------|--------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Wrangler env var | Account for SQL API |
| `PAGE_VIEWS_DATASET` | Wrangler env var (= TF output `page_views_dataset`) | SQL `FROM` table name |
| `CLOUDFLARE_ANALYTICS_API_TOKEN` | Terraform worker secret | Bearer for SQL API |

**Required:** set house name `ANALYTICS_CF_TOKEN` in `.env.dev` (or `TF_VAR_CLOUDFLARE_ANALYTICS_API_TOKEN`). `-LoadEnvFiles` maps it to `var.cloudflare_analytics_api_token`. Preflight and Terraform validation fail if empty. Terraform does **not** mint analytics API tokens. Details: `infra/terraform/CLOUDFLARE_API_TOKEN.md`.

**GitHub / CI:** `scripts/set-github-secrets.ps1 -SyncGitHubSecretsAndVars -AllowProduction` syncs:
- secret `TF_VAR_CLOUDFLARE_ANALYTICS_API_TOKEN` (from `ANALYTICS_CF_TOKEN`)
- variables `TF_VAR_PAGE_VIEWS_DATASET_STAGING` / `TF_VAR_PAGE_VIEWS_DATASET_PRODUCTION` (prefer terraform output `page_views_dataset`, else `.env.dev`, else documented defaults)

CI Terraform workflows pass those as `TF_VAR_page_views_dataset`.

**Never** set `CLOUDFLARE_ANALYTICS_API_TOKEN` from the Terraform Edit/super-token. Terraform does not fall back to `var.cloudflare_api_token` for this secret.

Do **not** use `wrangler secret put` as the primary path for the analytics token — Terraform owns it.

### 3. Redeploy Worker (binding present for writes)

After Terraform has the dataset id / binding / secrets, redeploy so ingest uses `PAGE_VIEWS`:

```powershell
# from repo root — staging Workers-only when ready to verify
.\scripts\deploy-staging-local.ps1 -WorkerOnly
# production only when you explicitly intend to ship site analytics live
```

### 4. Verify

1. Confirm id: `terraform … output -raw page_views_dataset`
2. On the target environment, open a **public** HTML page (production: `/` or `/posts/…`; staging: sign in, then `/homepage` or `/posts/…`).
3. Wait a short window for Analytics Engine ingest (usually seconds–minutes).
4. Open `/admin` → **Site traffic**, or go directly to `/admin/analytics` as an admin — paths should list (bots hidden by default).
5. Optional SQL smoke test:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --data "SHOW TABLES"
```

## Code map

| File | Role |
|------|------|
| `infra/terraform/modules/cloudflare_holding_page` | `analytics_engine_binding` + outputs |
| `infra/terraform/environments/{staging,production}` | `page_views_dataset` var, worker secrets, env outputs |
| `web/src/lib/page-view-analytics.ts` | Write filters, bot heuristics, SQL queries |
| `web/src/middleware.ts` | Records public page views after `next()` |
| `web/src/pages/api/admin/analytics/index.ts` | Admin JSON API (reads aggregates) |
| `web/src/pages/admin/index.astro` | Staff hub tile → `/admin/analytics` |
| `web/src/pages/admin/analytics.astro` | Staff UI — Site traffic / Public page views |
| `web/wrangler.jsonc` | `PAGE_VIEWS` binding must match TF output dataset name |

## Limits / follow-ups

- Not a substitute for product analytics or long-term BI — CF retains ~3 months.
- High-traffic paths may be sampled (`_sample_interval`); queries use `SUM(_sample_interval)`.
- Staging is Auth0-locked; expect sparse staging stats (editors only). Prefer production for real reader traffic.
- Optional later: sync dataset id through `set-github-secrets.ps1`, Grafana SQL API, or richer time-series charts.
- Confirm Bot Management is enabled on the zone if you need stronger bot discrimination than UA heuristics.
