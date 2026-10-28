# SEO: meta, structured data, weekly-summary navigation, sitemaps

Code: `web/src/lib/seo/article-seo.ts`, `web/src/lib/sitemap-resilience.ts`,
`web/src/lib/site-sitemap.ts`, `web/src/lib/site-sitemap-db.ts`,
`web/src/components/EmDashContentView.astro`,
`web/src/middleware.ts`. Tests: `npm run test:article-seo`, `npm run test:sitemap-resilience`,
`npm run test:site-sitemap` (all also run in `npm run build`); built-Worker checks in
`npm run test:worker-routes`.

## Meta (posts and pages)

| Output | Source | Fallback (previous behaviour) |
|---|---|---|
| `<title>` | `seo.title` | entry title |
| `og:title` / `twitter:title` | `social_title`, then `seo.title` | entry title (no date suffix any more) |
| meta / og / twitter description | `seo.description` | first excerpt paragraph |
| canonical | `seo.canonical` (http(s) or `/path`) | own URL: `/posts/<slug>`, `/archives/<slug>`, or `/<slug>` for `pages` (`contentCanonicalPath`) |
| robots | `seo.noIndex` → `noindex,nofollow` | `index,follow,max-image-preview:large` |

## Structured data (posts only)

Every post emits `NewsArticle` and `BreadcrumbList` JSON-LD. Empty properties are omitted.
Discrete optional fields on `posts` (populated by the AI pipeline; empty = omitted):

| Field | Type | JSON-LD |
|---|---|---|
| `lede` | text | `description` (else meta description) |
| `coverage_start`, `coverage_end` | datetime | `temporalCoverage` `start/end`; weekly ordering |
| `people` | repeater {name*, url} | `mentions[]` Person |
| `organisations` | repeater {name*, type, url} | `about[]` Organization |
| `places` | repeater {name*} | `spatialCoverage[]` Place |
| `social_title` | string | og:title / twitter:title |

Existing data used: title, published/updated dates, byline, `seo.image` + featured image,
publisher (`/social/avatar-ft-400.png` logo), `subjects` (keywords).

### Applying the schema (staging first)

Definition: `web/.emdash/schema-migrations/2026-10-13-posts-structured-data-fields.json`
(also merged into `web/.emdash/seed.json`).

1. Back up staging Turso (AGENTS.md §2), e.g.
   `turso db create staging-backup-<stamp> --from-db freedomtimes-emdash-staging --group freedomtimes-staging`.
2. For each field in the migration file call EmDash MCP `schema_create_field` on
   `freedomtimes-staging` with `collection: "posts"` and the field definition (AGENTS.md §3: MCP only).
3. `schema_get_collection {"slug":"posts"}` to verify. Production only when the operator asks.

The template tolerates the fields being absent, so code can deploy before or after the schema.

## Weekly summaries

Slug prefix `weekly-summary-`. Posts get previous/next links (`rel="prev"`/`rel="next"`) ordered by
`coverage_start`, else published date. There is no hub page: the homepage links every weekly summary,
and the retired `/weekly-summaries` URL 301s to `/`.

## Redirects (301)

`/posts/<slug>/` → `/posts/<slug>`; `/weekly-summaries` and `/weekly-summaries/` → `/`;
`/posts/{about-us,contact-us,privacy-policy,submit-a-tip}` → `/<slug>`.

## Sitemaps

| Sitemap | Lists | Built by |
|---|---|---|
| `/sitemap.xml` | index: `/sitemap-posts(-n).xml`, plus `/sitemap-site-pages.xml` on the public site | EmDash; the middleware adds the site-pages entry |
| `/sitemap-posts(-n).xml` | every indexable post at `/posts/<slug>` | EmDash (`posts` is the only collection with SEO + a URL pattern) |
| `/sitemap-site-pages.xml` | `/`, `/about-us`, `/contact-us`, `/privacy-policy`, `/archives`, each `/archives/<slug>` | middleware (`site-sitemap.ts`, #34) |

`/sitemap-site-pages.xml` uses the same row rule as EmDash's sitemaps: published, not deleted,
non-empty slug, not `seo_no_index`; drafts and unpublished items are never listed. Pages are
limited to `SITEMAP_PAGE_SLUGS` (about, contact, privacy). A row whose SEO canonical points
elsewhere is left out, so every `<loc>` equals the page's `<link rel="canonical">`. `lastmod`:
the row's `updated_at`; `/` uses the newest indexable post, `/archives` the newest archive.

All three are edge-cached (15 min fresh, 7 days last-known-good). If generation fails (any
non-200 or throw) the last-known-good copy is served, else `503` + `Retry-After: 300`. These
paths never 404 on the public site. Header `X-FT-Sitemap: generated|cache|stale`.

Locked staging (`SITE_ACCESS_MODE` not `public`): unchanged. `/sitemap.xml` and
`/sitemap-posts.xml` pass through EmDash uncached (`private, no-store`), the index does not list
`/sitemap-site-pages.xml`, and that path is EmDash's 404. Who can fetch sitemaps is unchanged.
