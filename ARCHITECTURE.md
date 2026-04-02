# Freedom Times — High-Level Architecture

> **Status:** Draft for discussion  
> **Goal:** Agree on a stack and delivery plan that can produce a public-facing MVP within two weeks.

---

## 1. Product Overview

Freedom Times is a UK/Europe-focused news platform for cult survivors. It vets stories and routes them as exclusives to established journalists. The two primary user groups are:

| Group | Need |
|---|---|
| **Public visitors** | Fast, readable, accessible news stories |
| **Admin editors** | Secure ability to create, edit, publish and delete stories |

---

## 2. Key Non-Functional Requirements

| Requirement | Notes |
|---|---|
| **Core Web Vitals / LCP** | Server-rendered HTML on first request; minimal JS shipped to the browser |
| **SEO** | Full SSR; pages must be crawlable without executing JavaScript |
| **Hosting** | Cloudflare Workers (not Pages) for full programmatic control; Workers can still serve static Assets |
| **PWA / App** | Packagable via Google Bubblewrap as Android/iOS TWA apps; requires HTTPS, Web App Manifest, Service Worker |
| **Push notifications** | Web Push API; note Apple only enabled this in iOS 16.4+ |
| **Newsletter** | Email subscription + periodic digest |
| **Infrastructure as Code** | All cloud resources (Azure, Cloudflare, Auth0) are defined in source-controlled declarative files and deployed via CI/CD; no manual portal drift |
| **Privacy / GDPR** | Protect survivor and reader privacy by design; collect the minimum data required for journalism operations only; no secondary profiling/advertising use |

---

## 3. High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Public Internet                          │
└───────────┬─────────────────────────────┬───────────────────────┘
            │                             │
    Browser (Visitor)              Browser (Editor / Admin)
            │                             │
            ▼                             │
┌───────────────────────┐                 │
│  Cloudflare Workers   │◄────────────────┘
│  (SSR + Asset Serving)│
│                       │  reads stories
│  ┌─────────────────┐  │◄──────────────┐
│  │ KV Store        │  │               │
│  │ (published      │  │  ┌────────────┴──────────┐
│  │  story cache)   │  │  │  Azure HTTP Functions  │
│  └─────────────────┘  │  │  (CRUD API)            │
│                       │  │                        │
│  ┌─────────────────┐  │  │  ┌──────────────────┐  │
│  │ R2 Bucket       │  │  │  │  Cosmos DB        │  │
│  │ (images/videos/ │  │  │  │  (canonical store │  │
│  │  static assets) │  │  │  │   for stories)   │  │
│  └─────────────────┘  │  │  └──────────────────┘  │
└───────────────────────┘  └────────────────────────┘
                                       ▲
                               Auth0 (RBAC)
                                       ▲
                               Editor's browser
```

---

## 4. Component Breakdown

### 4.1 Cloudflare Workers — Public SSR Layer

**Role:** Receives every HTTP request from the public; renders HTML server-side using data pulled from KV; serves static assets from R2/Workers Assets.

**Recommended framework:** [Astro](https://astro.build/) with the [`@astrojs/cloudflare` adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/).

- Astro's **Islands architecture** ships zero JS to the browser by default — ideal for a content-heavy news site where most pages are essentially read-only.
- Selective hydration means interactive widgets (search, subscribe form) are hydrated in isolation without blocking LCP.
- Astro can use the Cloudflare Workers runtime natively (no Node.js emulation layer, no cold-start overhead — Cloudflare uses V8 isolates, not containers).
- Astro generates a standard `manifest.webmanifest` and supports Service Worker injection, making PWA integration straightforward.

**Alternative worth considering:** [SvelteKit](https://kit.svelte.dev/) with the Cloudflare adapter — slightly heavier default JS bundle than Astro but still excellent, and gives a richer reactive component model for the progressive Admin UI.

> **Discussion point:** Does the Admin UI need enough reactivity to tip the balance toward SvelteKit? If the admin surface is small (a few CRUD forms), Astro with a sprinkle of Svelte islands is likely the better trade-off.

**Caching strategy:**

Two caching layers work together (see §4.2 for full Cache API details):

```
Request → Worker
  → Check caches.default (edge HTTP cache, per-datacenter)
    → Cache hit  → stream HTML to client  (zero KV reads)
    → Cache miss → Check KV for story JSON
        → KV hit  → render HTML → store in caches.default → stream to client
        → KV miss → fetch from Azure Function → render → store in KV + caches.default → stream to client
```

- **`caches.default`**: Caches the fully rendered HTML `Response` keyed by URL. A hit requires no KV reads and minimal CPU. Populated lazily per-datacenter; evicted automatically by Cloudflare.
- **Cloudflare KV**: Stores the canonical story JSON payload. Persists until explicitly deleted, surviving edge cache evictions and acting as the durable source of truth for re-rendering.

Published stories are written to KV by the Azure Function at publish time. When a story is published, updated, or deleted, the Azure Function both updates KV **and** calls the Cloudflare Cache Purge API to evict stale HTML from `caches.default` across all PoPs.

**Concern — KV eventual consistency:** Cloudflare KV has eventual consistency across regions. A freshly published story could take up to 60 seconds to propagate globally. For a news agency this is acceptable; the Azure Function's KV write will propagate before editors share the link. If sub-second global consistency is required, [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) or direct R2 reads would need to be evaluated.

---

### 4.2 Cloudflare Cache API — Edge Response Cache

Cloudflare Workers expose the [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) via `caches.default` — the shared HTTP response cache at each Cloudflare datacenter (point of presence). Unlike KV, the Cache API stores full `Response` objects keyed by URL, respects standard HTTP caching semantics, and has no per-read billing.

**`caches.default` vs Cloudflare KV:**

| Characteristic | `caches.default` | Cloudflare KV |
|---|---|---|
| Stores | Full `Response` objects (rendered HTML, JSON) | Arbitrary values (JSON, strings, binary) |
| Key | Request URL | Arbitrary string |
| Scope | Datacenter-local (each PoP holds its own copy) | Eventually consistent globally (~60 s propagation) |
| Eviction | Automatic — Cloudflare may evict at any time | Explicit TTL or manual delete |
| Cost | Free — no per-operation billing | Billed per read/write operation |
| HTTP semantics | Respects `Cache-Control`, `Vary`, etc. | Not HTTP-aware |

**Usage pattern inside the Worker:**

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const cache = caches.default;
    const cacheKey = new Request(request.url, { method: 'GET' });

    // 1. Check edge cache — zero KV reads on a hit
    let response = await cache.match(cacheKey);
    if (response) return response;

    // 2. Build the response (renders from KV data or Azure Function)
    response = await buildStoryResponse(request, env);

    // 3. Populate the local datacenter's edge cache (non-blocking)
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};
```

**Cache invalidation strategies:**

`caches.default` is populated lazily per-datacenter and is **not** automatically cleared when KV is updated. Explicit invalidation is required to avoid serving stale HTML after a story is published, edited, or deleted.

| Strategy | Mechanism | Plan / Cost |
|---|---|---|
| **TTL (`s-maxage`)** | `Cache-Control: s-maxage=3600, stale-while-revalidate=60` on each response. Auto-expiry is the safety-net baseline even when other strategies are in use. | Free |
| **URL purge (Cloudflare Purge API)** | Azure Function calls `POST /client/v4/zones/:zone_id/purge_cache` with `{ "files": [...] }` after each publish/update/delete. Propagates globally within ~2 seconds. | Free |
| **Prefix purge** | Purge all URLs under a path prefix (e.g., `/tag/trafficking/`). Useful when one story change invalidates many archive pages. | Free |
| **Cache Tags (`Cache-Tag` header)** | Tag responses at serve time (`Cache-Tag: story-{slug}`). A single purge call then invalidates all derivatives (story page, tag pages, OG-image route) simultaneously. | **Cloudflare Pro** or higher |
| **`caches.default.delete(url)` in Worker** | Removes from the current datacenter's cache only — **not** a global purge. Useful for self-healing within a request handler; not appropriate as a post-publish invalidation strategy. | Free |

**Recommended invalidation flow for MVP:**

```
Azure Function — on publish / update / delete:
  1. Write updated story JSON to KV  (or delete the KV entry on archive/delete)
  2. Call Cloudflare Cache Purge API  (API token: Cache Purge permission only)
       { "files": [ "https://freedomtimes.com/story/{slug}",
                    "https://freedomtimes.com/" ] }
  3. Return 200 to editor — stale HTML evicted at all PoPs within ~2 seconds
```

Use `s-maxage=3600` as the backstop for derivative URLs not explicitly named in the purge list (tag archives, sitemaps). Migrate to Cache Tags when per-story derivative pages multiply and maintaining a URL list becomes unwieldy.

> **Security:** Scope the `CLOUDFLARE_CACHE_PURGE_TOKEN` API token to `Cache Purge` on this zone only — no Workers, KV, or R2 access required. Store it as an Azure Function application secret, not in source code.

---

### 4.3 Cloudflare KV — Published Story Cache

Stores pre-serialised story payloads (JSON) keyed by story `slug`. The Worker reads from KV on every public page request — sub-millisecond reads within the same region.

```
Key:   story:{slug}
Value: JSON blob (headline, body, author, tags, publishDate, images…)

Key:   index:homepage
Value: JSON array of the latest N story summaries for the front page
```

Index keys (homepage, by-tag, etc.) are rewritten by the Azure Function whenever a story changes.

---

### 4.4 Cloudflare R2 — Media Storage

Stores:
- Uploaded images and videos attached to stories
- Static assets (fonts, icons) that are too large or binary for KV

R2 is S3-compatible and has no egress fees, making it well-suited for media. The Astro Worker can generate signed URLs or serve assets through a dedicated `assets.freedomtimes.com` Worker route.

---

### 4.5 Azure HTTP-Triggered Functions — CRUD API

**Language:** TypeScript (Node.js runtime on Azure Functions v4).

Responsibilities:
1. Authenticate the requesting editor via Auth0 JWT validation (JWKS endpoint).
2. Validate role claims (`role: editor` or `role: admin`).
3. Perform CRUD against Cosmos DB.
4. On **publish** or **update**: serialise the story and write to Cloudflare KV via the [Cloudflare API](https://developers.cloudflare.com/api/operations/workers-kv-namespace-write-key-value-pair-with-metadata) (authenticated with a KV API token stored as a Function secret).
5. On **delete**: remove the KV entry and update index keys.
6. On **media upload**: accept the binary, store in R2 via the S3-compatible API, return the CDN URL.

**Endpoints (sketch):**

| Method | Path | Description |
|---|---|---|
| `GET` | `/stories` | List stories (drafts + published) — admin only |
| `GET` | `/stories/{id}` | Get a single story by internal ID |
| `POST` | `/stories` | Create a draft story |
| `PUT` | `/stories/{id}` | Update headline/body/status/tags/etc. |
| `DELETE` | `/stories/{id}` | Soft-delete (archive) |
| `POST` | `/stories/{id}/publish` | Publish: writes to KV, sets `status=published` in Cosmos |
| `GET` | `/stories/search` | Query published stories by date/author/subject/tag (proxied to Azure AI Search) |
| `GET` | `/media/search` | Query canonical media by type/metadata/text (proxied to Azure AI Search) |
| `POST` | `/media` | Create or register a canonical media record |
| `POST` | `/media/upload` | Upload image, video, or document to R2 and attach to a canonical media record |
| `GET` | `/metadata/suggest` | Suggest people/groups/institutions from managed taxonomy + entity matching |
| `POST` | `/subscribers` | Register a newsletter subscriber |

**Cosmos DB container design:**

```
Database: freedomtimes
  Container: stories        (partition key: /pk)
  Container: media          (partition key: /mediaType)
  Container: subscribers    (partition key: /email)
```

Use a **synthetic key** on each story document:

```typescript
pk = `${status}|${publishYearMonth}`; // e.g. "published|2026-04"
```

This keeps hot write/read traffic for published stories distributed by month rather than concentrating all published documents in one partition.

Important limitation: a single synthetic key can optimize one primary access pattern, but it does not make unrelated predicates (author/subject/tag) partition-local. Queries such as "get by author" or "get by subject" will still fan out across partitions unless those dimensions are included in the partition key.

For flexible public and admin discovery (date ranges, author, subject, full-text), index published stories and canonical media in **Azure AI Search** and treat it as the query engine for read-heavy filtering while Cosmos remains the canonical transactional store.

Recommended split:
- Cosmos DB: source of truth, transactional CRUD, publish workflow.
- Azure AI Search: `get-by-date`, `get-by-author`, `get-by-subject`, media search, tag filters, keyword search, relevance/ranking.
- Cloudflare Worker: proxies `/stories/search` and `/media/search` to Azure AI Search to keep search admin keys off the client.

**Cost and CPU consideration:** Azure Functions on the Consumption plan have a very generous free tier (1 million invocations/month). Because admin writes are infrequent (not in the hot read path), this adds negligible cost.

---

### 4.6 Auth0 — Authentication & RBAC

Auth0 handles login for editors/admins and issues JWTs with custom role claims. The Admin UI requests a token from Auth0 (SPA flow or PKCE), then includes the Bearer token with every call to the Azure Function.

**Roles:**

| Role | Permissions |
|---|---|
| `editor` | Create and update own stories; upload media |
| `admin` | All editor permissions + delete stories + manage subscribers |

The Cloudflare Worker also validates tokens for any protected admin routes served within the same origin (e.g., `/admin/*`). This allows the progressive Admin UI to be progressively revealed within the same Astro application without a separate admin domain.

**Discussion point:** Hosting the admin UI within the same Workers origin (progressive enhancement) vs a separate subdomain (`admin.freedomtimes.com`). The same-origin approach gives a single deployment artefact and avoids CORS issues between admin UI and API. The trade-off is that the Worker needs to handle JWT validation.

---

### 4.7 Progressive Admin UI

The Admin UI is a set of **Astro islands** (or Svelte components) that are conditionally rendered when the Worker detects a valid admin JWT in the request (e.g., in a cookie set after Auth0 login). This avoids shipping any admin UI code to unauthenticated visitors.

Admin surfaces needed for MVP:
- Story list view (drafts + published)
- Story create/edit form (rich text body editor — e.g., [Tiptap](https://tiptap.dev/) or [Quill](https://quilljs.com/))
- Canonical media library with search, upload, reuse, and canonical name-based embedding
- Taxonomy-assisted metadata panel for people, groups, and institutions with editor confirmation
- Publish / Unpublish / Delete controls
- Subscriber list (read-only count + export for MVP)

---

### 4.8 PWA, Service Worker & Bubblewrap

1. **Web App Manifest** (`manifest.webmanifest`): name, icons, `display: standalone`, `theme_color` matching the Times-inspired palette.
2. **Service Worker**: pre-cache the shell (header, footer, fonts, CSS). Use a Stale-While-Revalidate strategy for story pages so they remain readable offline.
3. **Web Push**: subscribe visitors to push notifications via the [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API). Store only the technical subscription objects needed for message delivery in Cosmos DB (`subscribers` container). Notification preferences for Android/iOS app experiences should be stored locally on the device, not as a server-side behavioural profile. When a story is published, the Azure Function (or a secondary timer-triggered Function) sends push messages via VAPID.
   - ⚠️ **iOS caveat**: Web Push is only available in iOS 16.4+ when the site is added to the Home Screen as a PWA. For earlier iOS the Bubblewrap TWA wrapping gives native push notifications via FCM.
4. **Bubblewrap**: wraps the PWA as an Android TWA and an iOS WKWebView app. Both platforms use FCM/APNs via a thin native wrapper, bypassing the Web Push iOS limitation.

For app notifications specifically, any category preferences, mute settings, or similar reader choices should be persisted in on-device storage and applied client-side where feasible. The server should only know the minimum required delivery subscription details, not a rich per-reader notification preference profile.

---

### 4.9 Newsletter

- Subscribers provide email via a form (POST `/subscribers`).
- A **timer-triggered Azure Function** (e.g., weekly) queries recently published stories from Cosmos DB, renders an HTML email digest, and sends via a transactional email provider.
- **Recommended provider**: [SendGrid](https://sendgrid.com/) (free tier: 100 emails/day) or [Resend](https://resend.com/) (100/day free, modern API, TypeScript SDK). Resend is worth evaluating — simple API and good developer experience.
- Double opt-in should be implemented (GDPR requirement for EU subscribers).

---

### 4.10 Infrastructure as Code, Secrets, and Environment Promotion

All infrastructure must be declared in files committed to this repository and applied by deployment pipelines. Manual edits in Azure Portal, Cloudflare Dashboard, or Auth0 Dashboard are treated as break-glass only and must be reconciled back into IaC immediately.

**Preferred approach: Terraform as the single control plane**

Use Terraform as the default because it can manage all three providers in one graph:
- Azure: resource group, storage, Functions, Cosmos DB, App Insights, Key Vault, role assignments.
- Cloudflare: Workers routes, KV namespace bindings, R2 buckets, DNS, cache-related zone settings.
- Auth0: tenant resources, applications, APIs, RBAC roles, role-to-permission mappings.

---

### 4.11 API Auth Pattern (Agreed)

The agreed direction for editorial API authentication is:

1. Astro issues an API access token into an HttpOnly cookie on the parent domain (for example `.freedomtimes.news`).
2. Browser calls the API host on a subdomain (for example `api-staging.freedomtimes.news`) with `credentials: include`.
3. APIM reads token from the cookie, sets `Authorization: Bearer <token>` for upstream, and enforces JWT + role policy.
4. EasyAuth on Azure Function validates the upstream authorization header as a second gate.
5. Function executes business logic only after gateway + EasyAuth checks pass.

This keeps API tokens out of browser JavaScript while preserving gateway-level RBAC and Function-level token verification.

#### Implementation checklist (status)

Status is tracked for the agreed pattern above.

- [x] APIM JWT validation and role claim enforcement.
- [x] EasyAuth enabled on Azure Function.
- [x] Astro issues API token as `HttpOnly` cookie (domain-scoped for subdomain API host).
- [x] Browser calls API host with cookie credentials (`credentials: include`) and no JS bearer token.
- [x] APIM policy extracts token from cookie and sets upstream `Authorization` header.
- [x] APIM policy drops/overrides inbound client `Authorization` header.
- [x] APIM credentialed CORS (`allow-credentials=true`, explicit origins, no wildcard).
- [x] CSRF protection for state-changing endpoints in cookie-auth model.
- [x] Custom API hostname on Freedom Times domain (for example `api-staging.freedomtimes.news`).

Current state:

- Cookie -> APIM header bridge -> EasyAuth path is now implemented in application and APIM policy code.
- APIM custom hostnames are wired for staging (`api-staging.freedomtimes.news`) and production (`api.freedomtimes.news`), with certificate inputs required at deploy time.

#### Required controls for this pattern

- Cookie settings: `HttpOnly`, `Secure`, explicit `Domain`, explicit `Path`, short `Max-Age`.
- CORS with credentials on APIM: explicit allowed origins (no wildcard), `Access-Control-Allow-Credentials: true`.
- CSRF controls for cookie-authenticated API calls.
- APIM should overwrite or drop any inbound client `Authorization` header before setting upstream auth header from cookie token.
- Function direct hostname access should be treated as non-public and restricted over time.

This gives one plan/apply workflow, explicit dependencies, and auditable change history for the whole platform.

**Fallback approach when provider gaps exist:**

If a required resource is not reliably supported by a Terraform provider:
- Keep Terraform as orchestrator.
- Call specialist definitions as controlled steps, e.g., Bicep/ARM for Azure edge cases or provider-specific scripts.
- Keep these definitions in source control and run them from CI so deployment remains fully declarative.

**Secrets policy (no credential leakage):**

- Never store secrets in source code, tfvars files, or checked-in configuration.
- Store runtime secrets in Azure Key Vault (Function app settings reference Key Vault values).
- Store CI deploy secrets in GitHub Actions environments or OIDC-based federation where possible.
- Use least-privilege API tokens:
  - Cloudflare token scoped to required resources only (for example, Cache Purge or specific Worker/KV operations).
  - Auth0 management credentials scoped to required APIs only.
  - Azure identities scoped with minimal RBAC roles.

**Environment model:**

- Separate IaC workspaces/states for `dev`, `staging`, `prod`.
- Promotion path: `dev` -> `staging` -> `prod`, with plan review at each stage.
- Remote state with locking and encryption (for example, Azure Storage backend + blob lease locking).

**Recommended repository layout (high level):**

```text
/infra
  /terraform
    /modules
      /azure-core
      /cloudflare-edge
      /auth0-core
    /environments
      /dev
      /staging
      /prod
```

Each environment composes shared modules with environment-specific variables only; secrets are injected at deploy time.

---

### 4.11 Data Contracts, Publish Consistency, and Reconciliation

To avoid stale or contradictory public content, define explicit data contracts between the three read stores:
- **Cosmos DB**: canonical transactional source for story state.
- **Cloudflare KV**: denormalised read model for SSR rendering.
- **Azure AI Search**: discovery index for filter/search operations.

**Canonical publish/update/delete workflow:**

```
Editor action (publish/update/delete)
  -> Azure Function validates auth + payload
  -> Write canonical document to Cosmos DB (increment storyVersion)
  -> Project read model to KV (story + affected index keys)
  -> Upsert/delete Azure AI Search document
  -> Purge Cloudflare edge cache URLs
  -> Append audit event (operation, storyId, storyVersion, timestamp)
```

**Versioning and idempotency rules:**

- Each story carries a monotonic `storyVersion` (or ETag-backed equivalent).
- Downstream writes to KV/Search include `storyVersion`.
- Replayed publish events are safe: if incoming `storyVersion` is older than the current projection, ignore.
- Deletes use tombstone events so late-arriving retries cannot recreate stale records.

**Failure handling and retries:**

- If Cosmos write fails: return error; no downstream updates attempted.
- If KV or Search projection fails after Cosmos commit: mark `projectionStatus = pending` and enqueue retry.
- Retry worker performs exponential backoff and dead-letter after max attempts.
- Admin UI can display projection health for each story (`healthy`, `pending`, `failed`).

**Freshness SLOs (initial targets):**

- P95 publish-to-story-page freshness: under 5 seconds.
- P95 publish-to-search freshness: under 30 seconds.
- P99 projection retry completion: under 5 minutes.

These SLOs should be instrumented and tracked in Application Insights dashboards with alerting on sustained breaches.

**Reconciliation job (anti-drift control):**

- Run a scheduled reconciliation function (for example, every 15 minutes).
- Compare a rolling window of recently changed Cosmos stories against KV and Search projections.
- Auto-repair mismatches by re-projecting from Cosmos; emit metrics and audit records.

This keeps public rendering and search results consistent even when transient failures or partial outages occur.

---

### 4.12 Privacy, GDPR, and Data Minimisation

Privacy is a primary architectural value for Freedom Times. The platform serves cult survivors and sensitive readers, so every system should default toward data minimisation, constrained access, and limited retention.

**Core privacy principles:**

- Collect personal data only when it is required for journalism operations, editorial workflow, subscriber administration, security, or legal compliance.
- Do not collect reader or survivor data for advertising, profiling, behavioural targeting, or unrelated analytics.
- Do not collect user-identifiable telemetry for readers; no per-reader behavioural tracking, persistent identifiers, or session replay.
- Keep sensitive identity data separated from public editorial content and accessible only to tightly restricted roles.
- Prefer pseudonyms and aliases in public-facing content and routine editorial tooling.

**GDPR / UK-GDPR posture:**

- Define and document a lawful basis for each category of data collected.
- Provide clear privacy notices for readers, contributors, subscribers, and editors.
- Support subject rights workflows: access, rectification, erasure where applicable, and data export.
- Store data in UK/EU-aligned regions unless a justified exception is documented.
- Apply retention schedules so personal data is not retained indefinitely by default.

**Operational implications for the architecture:**

- Avoid third-party trackers, ad-tech scripts, and unnecessary analytics cookies.
- Use privacy-preserving operational telemetry focused on service health and threat awareness rather than reader profiling.
- Allowed request-context telemetry is limited to coarse, non-identifying signals such as country, ASN/network, high-level user-agent family, and similar non-fingerprinting request characteristics that help identify organised monitoring or hostile traffic patterns.
- Do not retain raw IP addresses, user-level identifiers, full user-agent strings where avoidable, cross-session identifiers, or derived browser fingerprints for ordinary readership telemetry.
- Keep newsletter subscriber data limited to what is needed for consent, subscription management, and delivery.
- Keep app notification preferences on-device wherever possible; do not centralise reader preference profiles unless a clearly justified operational need is documented.
- If source or survivor identity must ever be stored, keep it in a separate highly restricted store with stricter access controls and audit logging.
- Search indexes, caches, and projections must not expand the scope of personal data beyond the journalism purpose of the canonical record.

**Data collection rule:**

No data collection should be performed for any purpose other than journalism purposes, platform operation, security, consent management, and legally required compliance activities.

For readers specifically, telemetry must remain non-identifying and aggregated or coarse-grained by default. Its purpose is limited to operational security awareness, such as recognising unusual attention from particular countries, networks, or broad classes of client software, without building identifiable profiles of individual visitors.

---

## 5. Story Data Model

```typescript
interface Story {
  id: string;                  // UUID, Cosmos document ID
  slug: string;                // URL-safe, human-readable, unique
  headline: string;
  subHeadline?: string;
  summary?: string;            // 1–2 sentences for index pages / OG tags
  body: string;                // Rich HTML or Markdown; can reference canonical media by `name`
  authorAlias: string;         // Pseudonym to protect sources
  status: 'draft' | 'published' | 'archived';
  tags: string[];              // ["trafficking", "uk", "courts"]
  metadata: ContentMetadata;
  media: StoryMedia[];
  publishDate?: string;        // ISO 8601, set on first publish
  modifiedDate: string;        // ISO 8601, updated on every save
}

interface StoryMedia {
  id: string;                  // UUID, canonical media record ID
  name: string;                // Canonical globally unique identifier referenced from story body
  mediaType: 'video' | 'youtube' | 'image' | 'document';
  url: string;                 // R2 CDN URL or canonical external URL (e.g. YouTube)
  title: string;               // Human-friendly canonical name
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
  metadata: ContentMetadata;
  createdDate: string;
  modifiedDate: string;
}

interface ContentMetadata {
  people: string[];            // Canonical person names from managed taxonomy
  groups: string[];            // Canonical cult/group names from managed taxonomy
  institutions: string[];      // Canonical non-cult organisation names from managed taxonomy
}
```

`StoryMedia` is canonical and reusable across multiple stories. Each media record carries a canonical `name` that can be referenced directly from story body content.

`StoryMedia.name` should be globally unique across the platform, not just within a single story. That makes embed resolution deterministic, allows direct lookup in search/admin tools, and removes the need for a separate slug field. Treat `name` as a stable identifier; if editorial display text changes, update `title` rather than renaming `name` unless a controlled migration is performed.

The body embeds media by referencing `StoryMedia.name` tokens. At render time, the Worker or frontend component resolves the named media item and selects the correct renderer based on `mediaType` (for example, responsive `<img>`, hosted `<video>`, YouTube embed, or document link/download block).

Both `Story` and `StoryMedia` should be indexed for search. `ContentMetadata` values come from managed taxonomy lists for people, groups, and institutions. During article or media submission, the admin UI can prefill these fields using entity-matching heuristics against the maintained taxonomy, with the editor confirming or correcting suggestions before publish.

---

## 6. Look & Feel — Broadsheet / Times-Inspired

| Element | Approach |
|---|---|
| **Typeface** | Serif for headlines (e.g., *Playfair Display* or *Georgia*); clean sans-serif for body text (e.g., *Inter* or system-ui). Self-host fonts in R2 to avoid Google Fonts round-trips that hurt LCP. |
| **Colour palette** | Off-white background (`#FAFAF8`), near-black ink (`#1A1A1A`), a single accent (deep red `#B22222` or navy `#0A2540`) for section labels and interactive elements. |
| **Layout** | CSS Grid multi-column layout mimicking broadsheet column proportions. Large hero story with image; secondary stories in a 3-column grid below the fold. |
| **Whitespace** | Generous line-height (1.7), wide margins, clear typographic hierarchy. |
| **Images** | `<img loading="lazy">` with explicit `width`/`height` to prevent layout shift (CLS). Hero image eager-loaded for LCP. |
| **Dark mode** | `prefers-color-scheme` media query from day one; minimal overhead and good a11y. |

---

## 7. Deployment Pipeline

```
Developer / Editor action
        │
        ▼
GitHub repository
  (source of truth for frontend code)
        │
        ▼
GitHub Actions CI
  ├── IaC validate/plan (Terraform fmt/validate/plan)
  ├── IaC apply (gated per environment approval)
  ├── Lint + type-check
  ├── Build Astro → Workers bundle
  ├── Deploy to Cloudflare Workers via Wrangler
  └── Deploy Azure Functions (zip deploy / func action)
        │
        ▼
Cloudflare Workers (production)
        │
        reads stories from
        ▼
Cloudflare KV  ◄───── Azure Function (publish event)
```

Azure Functions are deployed separately (either via GitHub Actions + Azure CLI or VS Code Azure extension) and are independent of the Workers deployment.

---

## 8. Open Questions & Discussion Points

| # | Question | Options |
|---|---|---|
| 1 | **Astro vs SvelteKit** for the Worker? | Astro = less JS by default, simpler for content sites. SvelteKit = richer reactive admin UI. Can we use Astro + Svelte islands to get both? |
| 2 | **Rich text format** for story body: HTML or Markdown? | Markdown is easier to diff/store; HTML gives editors more control. Markdown-to-HTML at render time (e.g., `marked`) adds ~0.1 ms CPU. |
| 3 | **KV vs R2 for story cache**: KV values are limited to 25 MB; R2 objects are unlimited. For stories with many embedded images, should the canonical SSR source be R2 JSON files? | KV is fine for text payloads; R2 for blobs. Recommend KV for story JSON, R2 for media. |
| 4 | **Admin UI same-origin vs subdomain?** | Same-origin simplifies auth; subdomain gives a clean separation of concerns. |
| 5 | **Newsletter provider**: SendGrid vs Resend vs Mailchimp? | Resend recommended for developer simplicity; Mailchimp if list management UI is needed before admin is built. |
| 6 | **Cosmos DB partition key**: synthetic key shape and search split? | Recommended: synthetic `/pk = ${status}|${publishYearMonth}` for balanced writes + Azure AI Search for author/subject/date filtering and full-text. A single partition key cannot simultaneously optimize all independent query dimensions. |
| 7 | **GDPR / UK-GDPR compliance**: subscriber double opt-in, right to erasure, data residency? | Azure region should be `uksouth` or `northeurope`. Cosmos DB has point-in-time restore for accidental deletes. |
| 8 | **Source protection**: stories about cult survivors require careful handling of author/source metadata in the DB. | Author aliases only in public-facing fields; real identities (if stored at all) in a separate, highly restricted Cosmos container. |
| 9 | **Cache invalidation tier**: URL purge (free) vs Cache Tags (Cloudflare Pro) for post-publish freshness? | URL-based purge from the Azure Function covers MVP needs at no extra cost. Cache Tags enable single-call invalidation of all page derivatives (story, tag archives, OG routes) per story but require Cloudflare Pro (~$20/month). Recommended: URL purge for MVP; upgrade to Cache Tags if per-story derived-page count grows. |
| 10 | **IaC toolchain strategy**: Terraform-only vs mixed Terraform + specialist definitions? | Prefer Terraform-only for a single cross-platform graph. If provider gaps block delivery, keep Terraform as orchestrator and invoke specialist definitions (for example, Bicep) from CI while preserving full source-controlled declarative deployment. |
| 11 | **Projection consistency design**: synchronous publish path vs queued eventual projections to KV/Search? | Hybrid recommended: synchronous best-effort projection in publish path + durable retry queue + reconciliation job. This provides fast freshness with resilience to downstream failures. |
| 12 | **Metadata taxonomy governance**: how are canonical people, groups, and institutions curated? | Maintain managed taxonomy lists with editor/admin approval, entity-match suggestions during submission, and audit history for merges/renames to preserve search consistency. |
| 13 | **Privacy operating model**: what telemetry, analytics, and retention are acceptable? | Recommended: privacy-first defaults, minimal operational analytics only, explicit retention schedules, and no collection for advertising/profiling or unrelated secondary purposes. |

---

## 9. Deliverables

The following items are listed in priority order. Each should be completed and verified before moving to the next.

1. Scaffold Astro project; configure Cloudflare Workers with `wrangler`; deploy "Hello World" to production URL.
2. Create IaC foundation (`/infra`): Terraform providers/backends/modules for Azure, Cloudflare, Auth0; configure remote state + environment separation.
3. Implement secrets model: Key Vault + CI secret/OIDC wiring + least-privilege service principals/tokens.
4. Design system: typography, colour palette, CSS Grid layout; homepage shell.
5. KV integration: Worker reads story JSON from KV; story page template.
6. Static story fixtures in KV; homepage + article page rendering; Core Web Vitals baseline.
7. PWA: Web App Manifest + Service Worker; Lighthouse PWA audit.
8. Azure Function scaffold; Cosmos DB containers; CRUD endpoints; deploy to Azure.
9. Auth0 tenant setup via IaC; login flow in Astro Worker; JWT validation middleware.
10. Admin UI: story list, create/edit form, publish action (writes to KV).
11. Canonical media library: create/search/reuse media records, upload to R2, and support canonical name-based embeds.
12. Metadata taxonomy: managed lists for people, groups, and institutions with suggestion/prefill on submission.
13. Newsletter subscribe form; email digest wiring (Resend/SendGrid).
14. Implement story projection pipeline: `storyVersion`, KV/Search upsert flow, retry queue, dead-letter handling, and reconciliation timer job.
15. Define privacy controls: privacy notice, retention rules, consent capture, telemetry boundaries, and role-restricted handling of sensitive identity data.
16. End-to-end smoke test; Lighthouse audit; MVP sign-off.

---

## 10. Technology Summary

| Layer | Technology | Rationale |
|---|---|---|
| SSR Framework | [Astro](https://astro.build/) + `@astrojs/cloudflare` | Zero-JS-by-default, Islands hydration, native Workers runtime |
| Hosting | Cloudflare Workers | V8 isolates (no cold starts), global edge network, KV/R2 integration |
| Story Cache | Cloudflare KV | Sub-millisecond reads, ideal for published story payloads |
| Edge HTML Cache | Cloudflare Cache API (`caches.default`) | Per-datacenter HTTP response cache; zero read cost; programmatic invalidation via Cloudflare Purge API |
| Media Storage | Cloudflare R2 | S3-compatible, zero egress fees |
| CRUD API | Azure Functions (TypeScript, v4) | Serverless, Cosmos DB SDK, scalable |
| Database | Azure Cosmos DB (NoSQL) | Low-latency, globally distributed, flexible schema |
| Query/Search | Azure AI Search | Efficient filtered + full-text queries for stories and media (date, author, subject, tags, metadata taxonomy); avoids cross-partition fan-out for discovery queries |
| Metadata Taxonomy | Managed canonical lists in Cosmos DB + suggestion service | Normalises people, groups, and institutions across stories/media and improves prefill, search, and editorial consistency |
| Auth | Auth0 | Managed OIDC/JWT, RBAC, SPA + API support |
| Infrastructure as Code | Terraform (primary), Bicep/other specialist definitions (fallback) | Source-controlled, repeatable, auditable deployments across Azure + Cloudflare + Auth0 with a single preferred control plane |
| Privacy / Compliance | Privacy-by-design controls + GDPR / UK-GDPR operating procedures | Minimises data collection, constrains access to sensitive information, and keeps processing limited to journalism and operational necessity |
| Email | Resend (or SendGrid) | Simple API, TypeScript SDK, generous free tier |
| Push Notifications | Web Push (VAPID) + FCM via Bubblewrap | Cross-platform; TWA bridges iOS Web Push gap |
| App Packaging | Google Bubblewrap (TWA) | Wraps PWA as Android/iOS apps |
| CI/CD | GitHub Actions + Wrangler | Automated lint/build/deploy on push |
