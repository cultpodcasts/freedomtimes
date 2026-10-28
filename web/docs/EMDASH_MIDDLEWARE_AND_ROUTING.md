# EmDash middleware and Freedom Times routing

This is the contract for Worker request handling. New HTML-hang or login-wall
fixes must fit this model. Do not add Worker slug maps, app-owned
`_emdash_redirects` queries, or `getEmDashEntry` timeouts. Do not
`Astro.rewrite` `/` ↔ `/homepage` / `/login-wall` to compose two templates.

## Official middleware order

EmDash registers middleware in `buildMiddlewareEntries`
(`emdash/src/astro/integration/index.ts`):

1. Optional `middleware.outer` (`web/src/emdash-outer-middleware.ts`)
2. `emdash/middleware` — `getRuntime`, then `createRequestScopedDb` into ALS
3. `emdash/internal/middleware/redirect` — `_emdash_redirects` via `getDb()`
4. setup / auth / request-context
5. the page

`emdash/internal/middleware/redirect` is written to run **after** runtime init. EmDash 1.0 moved this entry point under `emdash/internal/`. Its
fallback `getDb()` “transparently returns the per-request scoped db (set in
ALS by the runtime middleware) or the singleton” (`redirect.ts`).

Calling that handler from `middleware.outer` (before `getRuntime`) uses the
isolate-wide libsql web client. On Cloudflare Workers, the next HTML request
trips workerd’s cross-request I/O guard: the document hangs at 0 bytes while
`/_emdash/*` (scoped after runtime) still answers.

**`middleware.outer` is for host/logging work that does not need the CMS
database.** It must not import `emdash/internal/middleware/redirect` or call `getDb()`.

## Request-scoped database (adapter hook, not a one-off)

EmDash’s `DatabaseDescriptor.supportsRequestScope` is the official Workers
path (`emdash/src/db/adapters.ts`). When true, the adapter **must** export
`createRequestScopedDb`. Runtime middleware installs that handle in ALS so
`getDb()` and redirect queries stay on this request, then `close()`s it.

Freedom Times opts in on the Turso descriptor in `web/astro.config.ts` and
implements `createRequestScopedDb` in `web/src/shims/kysely-libsql.ts`
(fresh Kysely + libsql client; Hyperdrive-style `waitUntil(destroy)` on
`close()`). Official `libsql()` still has no request-scope hook.

This is the same hook D1 sessions / bookmark cookies use. It is not an
app-level timeout around `getEmDashEntry`.

## Routing: one document per URL

`SITE_ACCESS_MODE` is a **runtime** Worker var (staging can be flipped to
`public`). Builds cannot tree-shake Homepage CSS off locked `/`.

Astro collects every `.astro` import’s CSS onto the route. Two full HTML
documents in one page module means newsroom `html,body` rules override the
Secure Access wall after logout.

| Mode | `/` | `/homepage` |
|------|-----|-------------|
| Locked | Anonymous wall (`secureAccessWallResponse`) | Newsroom (`HomepageView` only). No cookies → 302 `/`. Failed session → existing `requireEditorialSession` redirect (`/` or `/?denied=1`). |
| Public | Newsroom (`HomepageView` only) | 301 `/` on production hosts |

Do **not** `Astro.rewrite` `/` ↔ `/homepage` (or `/login-wall`) to compose
two templates — that is how newsroom CSS leaked onto the wall. After
`supportsRequestScope`, rewrite is not the 0-byte hang mechanism (that was
isolate-wide `getDb()`, seen on custom-domain version `230af65d` before the
scoped client). Belt-and-suspenders: keep these two URLs as redirect or
Response, not rewrite.

`/login-wall` remains a fallback that returns the same wall Response.

CMS slug redirects stay in EmDash (`emdash/internal/middleware/redirect` after
runtime). The app does not reimplement `_emdash_redirects`.

## What to do instead of the rejected hacks

| Symptom | Official lever |
|---------|----------------|
| HTML hangs after ~30s / second request | `supportsRequestScope` + `createRequestScopedDb`; never `getDb()` in `middleware.outer` |
| Weekly slug 302 | Let `emdash/internal/middleware/redirect` run after runtime |
| Locked `/` vs newsroom CSS | Wall is a Response; `/homepage` never renders the wall |
| Service worker eating navigations | SW must not intercept `navigate` / document requests |

## Anonymous reader page cache (production only)

`src/emdash-outer-middleware.ts` serves a Cache API copy of public reader pages
*before* EmDash `getRuntime`, so a hit costs no runtime init and no Turso round
trip. Policy: `src/lib/page-cache-policy.ts`; handler (dependency-injected,
behaviour-tested in `scripts/test-page-cache-handler.mts`):
`src/lib/page-cache-handler.ts`; Workers glue (Cache API + KV epoch):
`src/lib/page-cache.ts`.

- **On only when** `PAGE_CACHE=on` **and** `SITE_ACCESS_MODE=public`
  (`wrangler.jsonc`: production `on`, staging `off`; locked staging can never
  cache even if the flag is flipped, because every staging response is per-session).
- **TTL** `PAGE_CACHE_TTL_SECONDS` (default 120 s, max 600 s). The stored copy
  carries `Cache-Control: public, max-age=<ttl>`; the client gets the page's
  original Cache-Control (browser caching is unchanged).
- **Request bypass:** non-GET/HEAD; `Authorization`; any cookie except
  Cloudflare (`__cf_bm`, `cf_clearance`, `_cfuvid`, `__cflb`) and GA (`_ga*`, `_gid`);
  **any query string at all** (including `utm_*` / `fbclid`: `Layout.astro`
  canonical / `og:url` fallback and `Header.astro` `next=` render the query into
  the HTML, so query-bearing responses are never shared); any path outside `/`,
  `/robots.txt`, `/posts/<slug>`, `/archives[/<slug>]`, `/<page-slug>`.
  `/<page-slug>` is a catch-all, so every other top-level route must be listed in
  `DENY_TOP_LEVEL` (or `CACHEABLE_STATIC_ROUTES`); a test enumerates `src/pages/*`
  and fails for an unclassified new route. `/_*` and `/.well-known` never cache.
- **Response bypass:** status ≠ 200, `Set-Cookie` (header or pending `Astro.cookies`),
  `Cache-Control` private/no-store/no-cache, `Vary: Cookie|Authorization|*`, non-HTML/text.
- **Body check before store (#123):** the client copy streams as before; the cache
  copy is read to the end first and stored only if the stream did not error, the
  body is non-empty, it is at most `PAGE_CACHE_MAX_STORE_BYTES` (4 MB; past that the
  cache copy is cancelled and nothing is stored, the client copy is unaffected) and
  HTML is complete (`isCompleteStorableBody`): the last `</html>` must be in the final
  16 KB (`HTML_END_TAIL_BYTES`) and be followed only by whitespace and complete
  `<script>…</script>` blocks. Missing `</html>`, a script that never closes, or any
  other markup or text after `</html>` (comments, `<p>`, `<style>`) means not stored. A
  render that fails after the 200 headers errors the stream, so it is never cached; the
  stream-error check is the primary guard and the `</html>` tail check is a heuristic
  second line. Its two known limits are pinned by tests: a stream cut exactly at the end
  of `</html>`, before a trailing script, is accepted (harmless while nothing follows
  `</html>`), and a literal `</html>` or `</script>` string inside a trailing script makes
  the page not stored. Every reader page renders through `src/layouts/Layout.astro`,
  which ends with `</html>`; every component or page that imports `Layout` (found on
  disk, minus `DENY_TOP_LEVEL` pages the cache never serves) puts nothing but `<style>`
  after `</Layout>`, because Astro emits a
  `<script>` written there after `</html>` (article pages and `/contact-us` did this via
  `EmDashContentView` until web 0.0.42, so they were never stored). The script-tolerant
  check is the backstop; `scripts/test-page-cache-policy.mts` pins both rules.
- **Where database calls may run (#123):** anything that can fail the page loads in
  the **page** frontmatter, before rendering starts, so a failure there renders
  `src/pages/500.astro` (500, `no-store`, noindex, no canonical) instead of a cut-off
  200. That is the entry lookup (`[slug].astro`, `posts/[slug].astro` and
  `archives/[slug].astro` rethrow a lookup failure; only `[slug].astro`'s empty-slug branch, which is the error-render
  path itself, answers plain text) and the homepage list (`loadHomepageEntries()` in
  `index.astro` / `homepage.astro` / `[slug].astro`, passed to `HomepageView` as a
  prop). **Component** frontmatter runs after the 200 headers are sent, so a database
  call there must catch its errors and degrade, never throw mid-stream: today only
  `EmDashContentView` does this (social image `media` / `_emdash_seo` lookups fall
  back to the hero image; weekly prev/next is wrapped in try/catch).
  `scripts/test-homepage-entries-map.mts` lists every component / layout frontmatter
  `await`, so a new one has to be added there on purpose. The body check above is the
  backstop: a page cut off by a component failure is never cached.
  **Middleware** (`src/middleware.ts`) has one database read: `/sitemap-site-pages.xml`
  (#34, `src/lib/site-sitemap-db.ts`, public site only). It runs after EmDash's runtime
  middleware, so `getDb()` is the request-scoped client, and only inside
  `serveSitemapResiliently` (`src/lib/sitemap-resilience.ts`): any throw serves the
  last-known-good copy, else 503 + `Retry-After: 300`, and a partial sitemap is never
  cached. It must never run outside that wrapper and never in `middleware.outer`
  (`test-emdash-outer-middleware.mts` checks that outer does not import it). See
  [SEO_STRUCTURED_DATA.md § Sitemaps](SEO_STRUCTURED_DATA.md#sitemaps).
- **Purge:** site plugin `ft-page-cache-purge` (`src/plugins/page-cache-purge.ts`,
  hooks in `page-cache-purge-hooks.ts`) bumps the epoch in KV `SESSION` key
  `ft:page-cache:epoch` on `content:afterPublish|afterUnpublish|afterDelete|afterRestore`
  and on `content:afterSave` of published entries. Scheduled publishes run
  `content:afterPublish` too. The epoch is in the cache key, so every colo misses
  on its next read. **Staleness after a publish: typically under ~40 s**
  (10 s isolate memo + KV `cacheTtl` 30 s), **at most the page TTL** (120 s).
  Redirects inserted by SQL, SQL migrations, menus and site settings are not
  purged: bounded by the TTL.
- **Headers:** `x-ft-cache: HIT | MISS | BYPASS-<reason>` on reader-candidate
  requests only (admin, API, auth, assets and non-GET are passed through
  untouched); a hit sends `server-timing: ftcache;desc="HIT"`. Page views are
  still recorded on hits.
- No robots / noindex changes. The outer middleware still never calls `getDb`.

### Expected latency (estimate, not yet measured)

`caches.default` is **per colo, where the Worker runs**. With
`placement.region = aws:eu-west-1` the Worker (and so the cache) runs near
Dublin for every request, so a HIT still pays one eyeball ↔ Dublin round trip:

| Eyeball | HIT TTFB estimate | Today p50 (Workers observability, 27 Oct 2026) |
|---|---|---|
| UK / EU | ~0.1–0.2 s | LHR 944 ms |
| US East | ~0.2–0.25 s (0.15 s edge overhead measured on `robots.txt` + ~80 ms RTT) | IAD 2285 ms |
| US West | ~0.3 s | — |
| APAC (SYD) | ~0.4–0.6 s | SYD 9026 ms |

These are estimates from RTTs: a real US HIT cannot be measured without a
deploy. Measure after the first production deploy with
`curl -so /dev/null -w '%{time_starttransfer}\n' https://freedomtimes.news/` from
several regions and confirm `x-ft-cache: HIT` with `curl -sI`.

### Decision record: Cache API + KV epoch vs Workers Caching / `cacheCloudflare()`

*Decided 27 Oct 2026 for PR #111; revisit in the follow-up issue.*

**Chosen:** Workers Cache API (`caches.default`) inside the outer middleware, a
KV epoch for global purge.

**Alternative:** [Workers Caching](https://developers.cloudflare.com/workers/cache/)
(`"cache": {"enabled": true}` in wrangler, wrangler ≥ 4.69) driven by Astro route
caching + `@astrojs/cloudflare` `cacheCloudflare()` (sets
`Cloudflare-CDN-Cache-Control` + `Cache-Tag`, purges by tag via `cloudflare:workers`
`cache.purge`). It is served from a tiered cache near the eyeball **before** the
Worker runs and before placement is consulted ("The cache is always consulted
before Smart Placement is considered"), collapses concurrent misses, and
Cloudflare recommends it for new Workers
([limitations](https://developers.cloudflare.com/workers/cache/limitations/)).
That is strictly better for HIT latency outside Europe.

**Why not in this PR:**

1. **Signed-in safety.** The Workers Caching key does not include `Cookie`
   ("Requests that differ only in … `Cookie`, or `Authorization` return the same
   cached response", [cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)).
   Our fail-closed rule is request-side (any session cookie → never served from
   cache). With Workers Caching every reader route would have to emit
   `Vary: Cookie` (which fragments the anonymous variant by `__cf_bm` values) or
   signed-in editors/admins would be served the anonymous copy; only an
   `Authorization` header bypasses automatically
   ([configuration](https://developers.cloudflare.com/workers/cache/configuration/)).
2. **Analytics.** A Workers Caching HIT never runs the Worker, so
   `recordPageView` would stop counting cached views.
3. **Scope.** It needs route-level cache hints, tag purges wired to EmDash
   publish (EmDash's `@emdash-cms/cloudflare` scheduled handler already purges
   tags through the Astro cache provider), and staging validation. Purges use
   Free-tier rate limits.
4. **Availability.** The docs (updated 12 Oct 2026) show no beta gating; this
   was not verified on the account and has not been tried on staging.

**Also considered:** a dedicated KV namespace for the epoch. Rejected for now: it
needs a Terraform-managed namespace and a new binding in both envs; the epoch is
one namespaced key (`ft:page-cache:epoch`) in `SESSION`, whose session keys are
random IDs and cannot collide.
