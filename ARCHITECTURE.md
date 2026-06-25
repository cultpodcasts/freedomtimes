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
| **PWA / App** | Web-first delivery with optional Android/iOS packaging via Capacitor; requires HTTPS, Web App Manifest, and Service Worker support |
| **Push notifications** | Web Push API for the web experience, with native push integration available through Capacitor when app packaging requires it |
| **Newsletter** | Email subscription + periodic digest |
| **Infrastructure as Code** | All cloud resources (Cloudflare, Auth0, Turso) are defined in source-controlled declarative files and deployed via CI/CD; no manual portal drift |
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
          ┌──────────────────────────────┐         │
          │ Cloudflare Workers           │◄────────┘
          │ Astro app + EmDash runtime   │
          │                              │
          │  ┌────────────────────────┐  │
          │  │ EmDash collections     │  │
          │  │ posts / media / schema │  │
          │  └─────────────┬──────────┘  │
          │                │             │
          │  ┌─────────────▼──────────┐  │
          │  │ Turso / libSQL         │  │
          │  │ content + revisions    │  │
          │  └────────────────────────┘  │
          │                              │
          │  ┌────────────────────────┐  │
          │  │ Cloudflare R2          │  │
          │  │ media storage          │  │
          │  └────────────────────────┘  │
          └──────────────────────────────┘
              ▲
             Auth0 (editor auth)
              ▲
            Editor / MCP clients
```

---

## 4. Component Breakdown

### 4.1 Cloudflare Workers — Astro App + EmDash Runtime

**Role:** Receives every HTTP request from both public readers and authenticated editors, serves the Astro site, and hosts the EmDash admin, OAuth, and MCP endpoints inside the same Worker deployment.

**Recommended framework:** [Astro](https://astro.build/) with the [`@astrojs/cloudflare` adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/).

- Astro's **Islands architecture** ships zero JS to the browser by default — still a good fit for a content-heavy publication.
- The live site and CMS now share one deployment artifact rather than maintaining a separate public render path and custom editorial API.
- Astro runs natively on the Cloudflare Workers runtime, and the current app integrates EmDash directly through the `emdash/astro` integration.
- Public pages query EmDash collections directly at request time using helpers such as `getEmDashCollection('posts', { status: 'published' })` and `getEmDashEntry('posts', slug)`.

**Current integration shape:**

```ts
emdash({
  mcp: true,
  database: {
    type: 'sqlite',
    entrypoint: '<libsql shim>',
    config: {
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    },
  },
  storage: r2({ binding: 'MEDIA' }),
})
```

This means the Worker is no longer built around a custom story projection layer. Published content is served from the CMS-backed data model directly.

---

### 4.2 EmDash — CMS, Content Store, and Published Reads

EmDash is now the content-management system for Freedom Times.

What that means in practice:

- Content lives in EmDash-managed collections, with revision history stored in the backing database.
- Editors work in the EmDash admin under `/_emdash/admin`.
- External editorial tooling can talk to the same CMS via the EmDash MCP endpoint under `/_emdash/api/mcp`.
- The live site reads published entries directly from EmDash rather than from a separate KV projection or cache-specific read model.
- The homepage currently lists the latest published posts with `getEmDashCollection('posts', { status: 'published', orderBy: { published_at: 'desc', updated_at: 'desc' } })`.
- Post pages resolve individual entries with `getEmDashEntry('posts', slug)` and render the stored content through a shared EmDash-aware content view.

---

### 4.3 Turso / libSQL — Canonical Content Database

The canonical content store is no longer described as Cosmos plus a projected publish cache. In the current implementation, EmDash is backed by Turso/libSQL.

Current characteristics:

- The Worker uses the libSQL client via a compatibility shim suitable for Cloudflare Workers.
- EmDash stores collection data and revision state in database tables rather than in a bespoke application schema documented here.
- Draft and published state are managed inside EmDash's own content lifecycle.
- The site now depends on database-backed reads being consistent with EmDash's notion of live content, not on secondary cache invalidation.

This is the effective source of truth for stories, metadata, and revision history.

---

### 4.4 Cloudflare R2 — Media Storage

EmDash media storage is wired to Cloudflare R2 using `@emdash-cms/cloudflare`.

Stores:
- uploaded images and other CMS-managed media assets
- featured images referenced by homepage and post views
- future media library assets reused across entries

R2 remains the right fit for this part of the system because it is object storage, integrates cleanly with the Worker runtime, and matches the current EmDash storage adapter.

---

### 4.5 EmDash OAuth, MCP, and Publish Lifecycle

EmDash is not just a data library in this app; it is the editorial control plane.

```
Editor signs in via Auth0
  -> accesses /_emdash/admin
  -> creates or edits a draft revision in EmDash
  -> publish promotes the current draft to the live revision
  -> homepage and post routes query EmDash for published content
  -> readers see the updated content without a separate KV projection step
```

Important current details:

- Middleware explicitly keeps `/_emdash/*` and related OAuth discovery paths outside the outer Auth0 gate so EmDash can complete its own OAuth and MCP flows.
- The Worker currently normalizes some OAuth query parameters for EmDash clients and exposes compatibility redirects for `.well-known` metadata routes.
- The build includes a small post-build patch step that improves EmDash publish diagnostics in Workers and guards against a known publish-time schema drift problem while upstream behavior is being validated.
- Public rendering is driven by EmDash's published/live state, not by a manually maintained cache invalidation routine.

---

### 4.6 Auth0 — Authentication & RBAC

Auth0 handles login for editors/admins and issues JWTs with custom role claims. The web app uses Authorization Code flow and stores tokens in secure cookies; browser JavaScript does not read bearer tokens directly.

**Roles:**

| Role | Permissions |
|---|---|
| `editor` | Create and update own stories; upload media |
| `admin` | All editor permissions + delete stories + manage subscribers |

The Cloudflare Worker also validates tokens for any protected admin routes served within the same origin (e.g., `/admin/*`). This allows the progressive Admin UI to be progressively revealed within the same Astro application without a separate admin domain.

Consent and scope notes:

- Login requests minimal identity scope (`openid`) plus the configured API audience for role/permission-aware API access.
- First-party consent prompts are disabled on the Auth0 API resource server (`skip_consent_for_verifiable_first_party_clients = true`) so normal login does not require a separate consent click-through.

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

### 4.8 PWA, Service Worker & Capacitor

1. **Web App Manifest** (`manifest.webmanifest`): name, icons, `display: standalone`, `theme_color` matching the Times-inspired palette.
2. **Service Worker**: pre-cache the shell (header, footer, fonts, CSS). Use a Stale-While-Revalidate strategy for story pages so they remain readable offline.
3. **Web Push**: subscribe visitors to push notifications via the [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API). Store only the technical subscription objects needed for message delivery in a minimal server-side subscriber store. Notification preferences for Android/iOS app experiences should be stored locally on the device, not as a server-side behavioural profile. When a story is published, a background delivery job can send push messages via VAPID or a native push provider.
  - ⚠️ **iOS caveat**: Web Push is only available in iOS 16.4+ when the site is added to the Home Screen as a PWA. Where the packaged app needs broader notification support or tighter native lifecycle control, use Capacitor-native plugins rather than relying on Home Screen PWA behavior.
4. **Capacitor**: packages the existing web app for Android and iOS while preserving a single web-first codebase. Native plugins can be introduced selectively for push notifications, deep linking, splash screens, and other device capabilities that are awkward or unavailable in the browser alone.

For app notifications specifically, any category preferences, mute settings, or similar reader choices should be persisted in on-device storage and applied client-side where feasible. The server should only know the minimum required delivery subscription details, not a rich per-reader notification preference profile.

---

### 4.9 Newsletter

- Subscribers provide email via a form (POST `/subscribers`).
- A scheduled background job queries recently published EmDash content, renders an HTML email digest, and sends via a transactional email provider.
- **Recommended provider**: [SendGrid](https://sendgrid.com/) (free tier: 100 emails/day) or [Resend](https://resend.com/) (100/day free, modern API, TypeScript SDK). Resend is worth evaluating — simple API and good developer experience.
- Double opt-in should be implemented (GDPR requirement for EU subscribers).

---

### 4.10 Infrastructure as Code, Secrets, and Environment Promotion

All infrastructure must be declared in files committed to this repository and applied by deployment pipelines. Manual edits in the Cloudflare Dashboard or Auth0 Dashboard are treated as break-glass only and must be reconciled back into IaC immediately.

> **Historical note:** Earlier drafts of this document described an Azure editorial API stack (Function App, API Management, Easy Auth, Cosmos DB). That plan was superseded. Freedom Times has **no Azure resources** — editorial and public traffic run on Cloudflare Workers with EmDash, Turso, and R2. See `NON_TERRAFORM_RESOURCES.md` for bootstrap-only manual steps.

**Preferred approach: Terraform as the single control plane**

Use Terraform as the default because it manages the active providers in one graph:
- **Cloudflare**: Worker routes, KV namespace bindings, R2 buckets, DNS, cache-related zone settings.
- **Auth0**: tenant resources, applications, APIs, RBAC roles, role-to-permission mappings.
- **Turso**: EmDash database resources per environment.

**Secrets policy (no credential leakage):**

- Never store secrets in source code, tfvars files, or checked-in configuration.
- Store runtime Worker secrets via Wrangler (`wrangler secret put`) and keep them in sync from `.env.dev` using `scripts/set-github-secrets.ps1`.
- Store CI deploy secrets in GitHub Actions environments.
- Use least-privilege API tokens:
  - Cloudflare token scoped to required resources only.
  - Auth0 management credentials scoped to required APIs only.
  - Turso API token scoped to required databases only.

**Environment model:**

- Separate Terraform Cloud workspaces for `staging` and `production`.
- Promotion path: `staging` -> `production`, with plan review at each stage.
- Remote state with locking via Terraform Cloud.

**Recommended repository layout (high level):**

```text
/infra
  /terraform
    /modules
      /cloudflare_holding_page
      /auth0_app
    /environments
      /auth0-shared
      /staging
      /production
```

Each environment composes shared modules with environment-specific variables only; secrets are injected at deploy time.

---

### 4.11 Auth Pattern (Current)

Editorial authentication is **same-origin** on the Cloudflare Worker. There is no separate API gateway, no Azure API Management (APIM), and no Easy Auth layer.

1. Editor visits `/auth/login` → Auth0 Authorization Code flow.
2. `/auth/callback` exchanges the code, verifies `admin` or `editor` role claims, and sets HttpOnly cookies (`ft_session`, `ft_access_token`, `ft_csrf`) scoped to the site domain.
3. Protected Astro routes (for example `/homepage`, `/signed-in`) validate the session JWT in Worker middleware.
4. EmDash admin (`/_emdash/admin`) and MCP (`/_emdash/api/mcp`) run on the same Worker origin; EmDash handles its own OAuth and MCP token flows alongside the outer Auth0 gate.
5. Browser JavaScript does not read bearer tokens; auth is cookie-based with CSRF protection on state-changing requests.

The Auth0 API audience identifier (for example `https://api.freedomtimes.news`) is a **resource-server identifier** for access tokens and RBAC — not a live Azure or APIM hostname.

#### Implementation checklist (status)

- [x] Auth0 login/callback/logout routes in the Worker.
- [x] HttpOnly session and access-token cookies with domain scoping and stale-cookie cleanup.
- [x] Role claim enforcement (`admin`, `editor`) at callback and protected routes.
- [x] CSRF cookie (`ft_csrf`) for cookie-authenticated requests.
- [x] EmDash admin and MCP on the same Worker deployment.
- [x] First-party Auth0 consent skipped for normal login.

#### Required controls

- Cookie settings: `HttpOnly`, `Secure`, explicit `Domain`, explicit `Path`, appropriate `Max-Age`.
- CSRF controls for cookie-authenticated state-changing requests.
- Middleware keeps `/_emdash/*` and OAuth discovery paths available for EmDash's own auth flows.

---

### 4.12 EmDash Data Contracts, Revision State, and Publish Consistency

To avoid stale or contradictory public content, the architecture should now describe the contracts that matter in the current EmDash-backed system:

- **Turso / libSQL via EmDash**: canonical source for entries, schema, and revision state.
- **Cloudflare R2**: canonical store for CMS-managed media assets.
- **Astro routes using EmDash helpers**: the live read path for published content.

**Canonical create/update/publish flow:**

```
Editor action in EmDash admin or MCP client
  -> authenticate through Auth0 / EmDash OAuth flow
  -> create or edit draft revision in EmDash
  -> publish promotes draft revision to live revision
  -> homepage and post routes query EmDash for published content
  -> R2-backed media is resolved as part of rendered entries
```

**Current consistency rules:**

- The site should treat EmDash's live revision as the only authoritative published version of an entry.
- Homepage and article rendering should query for `status: 'published'` or a published entry lookup rather than maintaining a second publish projection.
- Slug resolution must remain compatible with the CMS's own entry and revision model.
- Media references should remain stable across draft and published revisions because the binary assets live in R2 outside the HTML render path.

**Current operational note:**

- The current Worker build includes a compatibility patch that improves publish diagnostics and tolerates one known publish-time schema drift case in staging.
- Until that underlying behavior is fully resolved upstream, publish reliability should be validated as an EmDash runtime concern rather than as a cache-invalidation or projection concern.

This keeps the document aligned with the actual system: one CMS-backed source of truth, revision-based publishing, and direct published reads from EmDash.

---

### 4.13 Privacy, GDPR, and Data Minimisation

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

The application no longer relies on a hard-coded backend story model defined in application code.

With EmDash, the content model is managed by the CMS itself:

- collections and fields are defined in EmDash rather than in a C# or custom API contract layer
- the Worker reads entries by collection name and field keys at runtime
- editorial schema can evolve inside the CMS without requiring every content-type change to begin as a code-level model change

For the current site, the important contract is therefore behavioral rather than strongly typed:

- there is a `posts` collection used for homepage and article rendering
- entries have a stable identifier plus a slug-like public lookup field
- the rendered post shape includes title, summary or excerpt, main content, publish or update timestamps, and optional featured media
- media assets are stored through EmDash in R2 and referenced from entry data rather than from a separate handwritten backend model
- draft and published state are governed by EmDash revisions and live publication status

The frontend should treat EmDash entry data as CMS-owned content, then normalize only the fields it needs for rendering. That is already how the current Astro routes behave: they read published entries from EmDash and defensively extract values such as slug, title, excerpt, featured image, `publishedAt`, and `updatedAt`.

This gives the project a better separation of concerns:

- EmDash owns content-type definition, editorial workflow, and revision semantics
- the Astro app owns presentation and minimal field normalization for pages
- infrastructure owns database, media storage, auth, and deployment concerns

Where stronger guarantees are needed, they should be expressed as CMS schema rules, editorial validation, or small route-level normalization helpers, not as a large handwritten application-wide content model that drifts from the CMS.

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
  ├── Build Astro + EmDash Workers bundle
  ├── Apply Worker-compatible EmDash bundle patches
  ├── Deploy to Cloudflare Workers via Wrangler
  └── Verify runtime access to Turso + R2 bindings
        │
        ▼
Cloudflare Workers (production)
        │
  reads published entries from
  ▼
EmDash on Turso/libSQL
```

The current content-management path is contained within the Worker deployment plus its runtime bindings. Content publishing does not depend on a separate KV projection or cache purge stage.

---

## 8. Open Questions & Discussion Points

| # | Question | Options |
|---|---|---|
| 1 | **Astro vs SvelteKit** for the Worker? | Astro = less JS by default, simpler for content sites. SvelteKit = richer reactive admin UI. Can we use Astro + Svelte islands to get both? |
| 2 | **Rich text format** for story body: HTML or Markdown? | Markdown is easier to diff/store; HTML gives editors more control. Markdown-to-HTML at render time (e.g., `marked`) adds ~0.1 ms CPU. |
| 3 | **EmDash schema governance**: how much of the content model should remain inside EmDash collections versus custom app code? | Keep core editorial structure in EmDash collections and only move app-specific derived behavior into custom code when the CMS model cannot express it cleanly. |
| 4 | **Admin UI same-origin vs subdomain?** | Same-origin simplifies auth; subdomain gives a clean separation of concerns. |
| 5 | **Newsletter provider**: SendGrid vs Resend vs Mailchimp? | Resend recommended for developer simplicity; Mailchimp if list management UI is needed before admin is built. |
| 6 | **EmDash publish reliability**: should temporary Worker bundle patches remain in-repo until upstream fixes land? | Keep the patch while staging proves the publish path, but document each patch clearly and remove it once upstream behavior is reliable. |
| 7 | **GDPR / UK-GDPR compliance**: subscriber double opt-in, right to erasure, data residency? | Keep editorial content and subscriber workflows aligned with UK/EU privacy expectations and document retention/export/delete procedures explicitly. |
| 8 | **Source protection**: stories about cult survivors require careful handling of author/source metadata in the DB. | Author aliases only in public-facing fields; real identities (if stored at all) in a separate, highly restricted store with narrower access than the editorial CMS itself. |
| 9 | **Slug and revision semantics**: how should the app behave when EmDash direct entry lookup misses but legacy or draft metadata still exists? | Prefer explicit published-entry behavior first, with narrowly scoped fallbacks only where routing or recovery workflows still require them. |
| 10 | **IaC toolchain strategy**: Terraform-only vs mixed Terraform + specialist definitions? | Prefer Terraform-only for a single cross-platform graph. If provider gaps block delivery, keep Terraform as orchestrator and invoke provider-specific scripts from CI while preserving full source-controlled declarative deployment. |
| 11 | **MCP editorial workflow**: how much operational publishing should happen via MCP clients versus inside the EmDash admin UI? | Use MCP for automation and assisted workflows, but keep the browser admin flow as the baseline path for editing, publishing, and troubleshooting. |
| 12 | **Metadata taxonomy governance**: how are canonical people, groups, and institutions curated? | Maintain managed taxonomy lists with editor/admin approval, entity-match suggestions during submission, and audit history for merges/renames to preserve search consistency. |
| 13 | **Privacy operating model**: what telemetry, analytics, and retention are acceptable? | Recommended: privacy-first defaults, minimal operational analytics only, explicit retention schedules, and no collection for advertising/profiling or unrelated secondary purposes. |

---

## 9. Deliverables

The following items are listed in priority order. Each should be completed and verified before moving to the next.

1. Scaffold Astro project; configure Cloudflare Workers with `wrangler`; deploy "Hello World" to production URL.
2. Create IaC foundation (`/infra`): Terraform providers/backends/modules for Cloudflare, Auth0, and Turso; configure remote state + environment separation.
3. Implement secrets model: Wrangler secrets + GitHub Actions secret sync + least-privilege API tokens.
4. Design system: typography, colour palette, CSS Grid layout; homepage shell.
5. Integrate EmDash into the Astro Worker with Turso/libSQL and R2 bindings.
6. Implement homepage + article page rendering against published EmDash entries; establish Core Web Vitals baseline.
7. PWA: Web App Manifest + Service Worker; Lighthouse PWA audit.
8. Configure EmDash admin, OAuth, and MCP access inside the Worker deployment.
9. Auth0 tenant setup via IaC; login flow in Astro Worker; JWT validation middleware.
10. Editorial UI: story list, create/edit form, publish action through EmDash.
11. Canonical media library: create/search/reuse media records, upload to R2, and support canonical name-based embeds.
12. Metadata taxonomy: managed lists for people, groups, and institutions with suggestion/prefill on submission.
13. Newsletter subscribe form; email digest wiring (Resend/SendGrid).
14. Harden EmDash publish reliability in Workers and remove temporary compatibility patches once upstream fixes are no longer required.
15. Define privacy controls: privacy notice, retention rules, consent capture, telemetry boundaries, and role-restricted handling of sensitive identity data.
16. End-to-end smoke test; Lighthouse audit; MVP sign-off.

---

## 10. Technology Summary

| Layer | Technology | Rationale |
|---|---|---|
| SSR Framework | [Astro](https://astro.build/) + `@astrojs/cloudflare` | Zero-JS-by-default, Islands hydration, native Workers runtime |
| Hosting | Cloudflare Workers | V8 isolates, global edge deployment, and a single runtime for the public site plus EmDash |
| CMS | [EmDash](https://www.npmjs.com/package/emdash) | Integrated admin, revision-based publishing, MCP support, and direct published-content reads inside the Astro app |
| Content Database | Turso / libSQL | Managed SQLite-compatible backing store that works with the current Worker-compatible EmDash setup |
| Media Storage | Cloudflare R2 | S3-compatible, zero egress fees |
| Metadata Taxonomy | Managed canonical lists in CMS-backed content and supporting app logic | Normalises people, groups, and institutions across stories/media and improves prefill, search, and editorial consistency |
| Auth | Auth0 | Managed OIDC/JWT, RBAC, SPA + API support |
| Infrastructure as Code | Terraform | Source-controlled, repeatable, auditable deployments across Cloudflare + Auth0 + Turso |
| Privacy / Compliance | Privacy-by-design controls + GDPR / UK-GDPR operating procedures | Minimises data collection, constrains access to sensitive information, and keeps processing limited to journalism and operational necessity |
| Email | Resend (or SendGrid) | Simple API, TypeScript SDK, generous free tier |
| Push Notifications | Web Push (VAPID) with optional native push via Capacitor plugins | Keeps web push for the browser while leaving room for packaged-app notification support |
| App Packaging | Capacitor | Packages the existing web app for Android/iOS without introducing a separate native application stack |
| CI/CD | GitHub Actions + Wrangler | Automated lint/build/deploy on push |
