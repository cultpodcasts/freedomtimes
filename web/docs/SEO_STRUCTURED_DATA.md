# SEO: meta, structured data, weekly-summary navigation, sitemaps

Code: `web/src/lib/seo/article-seo.ts`, `web/src/lib/sitemap-resilience.ts`,
`web/src/components/EmDashContentView.astro`,
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

### Hero image (posts and pages)

`resolveHeroImage` (`web/src/lib/content/heroImage.ts`) picks the hero once and reads its `src` and
alt from the same field: `featured_image` when it has a file, otherwise `cover_image` when it has
one. A featured image with alt but no file does not count, so the cover (and its alt) is used.

Hero `<img>` alt order: the alt stored on the rendered image (`featured_image.alt` or
`cover_image.alt`), then the legacy flat string for that field (`featured_image_alt` /
`cover_image_alt`), then the other field's legacy string, then `"<title> featured image"`. Empty or
whitespace-only alt counts as unset.

The stored alt is a snapshot. In EmDash 1.3.1 the admin picker copies the media library item's alt
onto the post's image value when the image is chosen. On save, EmDash fills an empty alt from the
media item only when it also has to look up other metadata (dimensions, storage key, file info or
placeholder). Editing alt in the media library does **not** update posts that already use the image.
Set the alt on the post's image field, or re-pick the image
([#133](https://github.com/cultpodcasts/freedomtimes/issues/133)).

`og:image:alt` / `twitter:image:alt` are separate and unchanged: they are the social title whenever
there is an `og:image`. When a post has no social image (`seo.image` / `social_image`), `og:image`
falls back to the hero image, but `og:image:alt` is still the social title, not the hero alt
([#132](https://github.com/cultpodcasts/freedomtimes/issues/132)).

Test: `npm run test:hero-image-alt` (also in `npm test`). See
[#108](https://github.com/cultpodcasts/freedomtimes/issues/108).

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

`/sitemap.xml` and `/sitemap-posts(-n).xml` are edge-cached (15 min fresh, 7 days last-known-good).
If EmDash generation fails (any non-200 or throw) the last-known-good copy is served, else
`503` + `Retry-After: 300`. These paths never 404. Header `X-FT-Sitemap: generated|cache|stale`.
Who can fetch sitemaps is unchanged.
