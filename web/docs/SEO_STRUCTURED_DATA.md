# SEO: meta, structured data, weekly-summary navigation, sitemaps

Code: `web/src/lib/seo/article-seo.ts`, `web/src/lib/sitemap-resilience.ts`,
`web/src/components/EmDashContentView.astro`, `web/src/pages/weekly-summaries.astro`,
`web/src/middleware.ts`. Tests: `npm run test:article-seo`, `npm run test:sitemap-resilience`
(both also run in `npm run build`).

## Meta (posts and pages)

| Output | Source | Fallback (previous behaviour) |
|---|---|---|
| `<title>` | `seo.title` | entry title |
| `og:title` / `twitter:title` | `social_title`, then `seo.title` | entry title (no date suffix any more) |
| meta / og / twitter description | `seo.description` | first excerpt paragraph |
| canonical | `seo.canonical` (http(s) or `/path`) | own URL |
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
`coverage_start`, else published date. Hub at `/weekly-summaries` (nav link, listed in
`sitemap-posts.xml`, same access rules as posts — staging stays locked).

## Redirects (301)

`/posts/<slug>/` → `/posts/<slug>`; `/weekly-summaries/` → `/weekly-summaries`;
`/posts/{about-us,contact-us,privacy-policy,submit-a-tip}` → `/<slug>`.

## Sitemaps

`/sitemap.xml` and `/sitemap-posts(-n).xml` are edge-cached (15 min fresh, 7 days last-known-good).
If EmDash generation fails (any non-200 or throw) the last-known-good copy is served, else
`503` + `Retry-After: 300`. These paths never 404. Header `X-FT-Sitemap: generated|cache|stale`.
Who can fetch sitemaps is unchanged.
