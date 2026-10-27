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
trip. Policy: `src/lib/page-cache-policy.ts`; runtime glue: `src/lib/page-cache.ts`.

- **On only when** `PAGE_CACHE=on` **and** `SITE_ACCESS_MODE=public`
  (`wrangler.jsonc`: production `on`, staging `off`; locked staging can never
  cache even if the flag is flipped, because every staging response is per-session).
- **TTL** `PAGE_CACHE_TTL_SECONDS` (default 120 s, max 600 s). The stored copy
  carries `Cache-Control: public, max-age=<ttl>`; the client gets the page's
  original Cache-Control (browser caching is unchanged).
- **Request bypass:** non-GET/HEAD; `Authorization`; any cookie except
  Cloudflare (`__cf_bm`, `cf_clearance`, `_cfuvid`, `__cflb`) and GA (`_ga*`, `_gid`);
  any query param other than tracking ones (`utm_*`, `fbclid`, `gclid`, `msclkid`,
  `mc_cid`, `mc_eid`, `ref`); any path outside `/`, `/robots.txt`,
  `/posts/<slug>`, `/archives[/<slug>]`, `/<page-slug>` (and never `/_*`, `/.well-known`,
  `/api`, `/admin`, `/auth`, `/homepage`, `/login-wall`, `/signed-in`, tips, sitemaps).
- **Response bypass:** status ≠ 200, `Set-Cookie` (header or pending `Astro.cookies`),
  `Cache-Control` private/no-store/no-cache, `Vary: Cookie|Authorization|*`, non-HTML/text.
- **Purge:** site plugin `ft-page-cache-purge` (`src/plugins/page-cache-purge.ts`)
  bumps the epoch in KV `SESSION` key `ft:page-cache:epoch` on
  `content:afterPublish|afterUnpublish|afterDelete|afterRestore` and on
  `content:afterSave` of published entries. The epoch is in the cache key, so every
  colo misses on its next read (isolate memo 10 s + KV cacheTtl 30 s). Redirects
  inserted by SQL, menus and site settings are not purged: bounded by the TTL.
- **Headers:** `x-ft-cache: HIT | MISS | BYPASS-<reason>`; a hit sends
  `server-timing: ftcache;desc="HIT"`. Page views are still recorded on hits.
- No robots / noindex changes. The outer middleware still never calls `getDb`.
