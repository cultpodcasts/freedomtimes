# Post-build Cloudflare bundle patches

`web/scripts/patch-cloudflare-bundle.ts` runs as the **last step** of `npm run build`:

```text
tsx scripts/build-service-worker.ts && astro build && tsx scripts/patch-cloudflare-bundle.ts
```

After `@astrojs/cloudflare` emits the Worker bundle under `dist/server/`, the script walks every `**/*.mjs` file and applies string replacements to fix EmDash, OAuth, and Astro-on-Workers runtime issues that are not yet fixed upstream.

If `dist/server` does not exist, the script logs a warning and exits `0` (no failure).

---

## Operational notes

### Brittleness

Every patch is a **literal substring match** on minified or bundled output. A dependency upgrade, EmDash version bump, or Astro adapter change can change whitespace, rename symbols, or reorder code so a needle no longer appears. The script **does not fail** when a needle is missing — it silently skips that replacement.

**Recommendation for future patches:** prefer **fail-fast** behavior (exit non-zero when an expected needle is not found in a file you know should contain it) so CI surfaces drift immediately instead of shipping a broken Worker.

### Build log output

At the end of a successful run:

| Log line | Meaning |
|---|---|
| `[patch-cloudflare-bundle] patched N file(s)` | Count of `.mjs` files whose contents changed |
| `publish syncDataColumns guard: found=…, applied=…` | EmDash publish column-drift guard (see below) |
| `publish error diagnostics: found=…, applied=…` | EmDash MCP publish error detail patch (see below) |

Only the **last two** patches report per-needle `found` / `applied` counters. All other patches are silent unless they contribute to the patched-file count.

---

## Patches (in script order)

### 1. OAuth CSRF cookie path

| | |
|---|---|
| **What it fixes** | Rewrites the CSRF cookie `Path` from `/_emdash/api/oauth/authorize` to `/_emdash/oauth/authorize`. |
| **Why needed** | EmDash OAuth authorize lives at `/_emdash/oauth/authorize` (see `web/src/middleware.ts`). Older bundled EmDash code set the CSRF cookie path to the wrong URL segment, so the browser did not send the cookie on the consent POST. |
| **Symptoms if missing** | EmDash OAuth consent fails with CSRF validation errors; editorial login / admin OAuth flow breaks at consent. |
| **Remove when** | Upstream EmDash (or the bundled OAuth handler) sets `Path=/_emdash/oauth/authorize` in generated Worker output. |
| **Build logs** | No `found`/`applied` line; silent `replaceAll` across all `.mjs` files. |

### 2. `createRequire` import URL

| | |
|---|---|
| **What it fixes** | Replaces `createRequire(import.meta.url)` with `createRequire('/')`. |
| **Why needed** | Node compatibility shims in the bundled Worker use `createRequire(import.meta.url)`, which does not resolve correctly in the Cloudflare Workers runtime. A fixed root path works for the bundled layout. |
| **Symptoms if missing** | Runtime errors when EmDash or a dependency tries to `require()` Node built-ins or CJS modules inside the Worker (build may succeed, deploy fails or 500s on affected routes). |
| **Remove when** | Upstream bundler / EmDash / adapter emits a Workers-safe `createRequire` call without relying on `import.meta.url`. |
| **Build logs** | No `found`/`applied` line; silent `replaceAll`. |

### 3. Writable response for baseline security headers

| | |
|---|---|
| **What it fixes** | Replaces `setBaselineSecurityHeaders` so it clones the `Response` when header mutation throws, sets headers on the writable copy, and **returns** that response. |
| **Why needed** | Some EmDash/OAuth responses arrive with **immutable** headers in Workers. Mutating them in place throws; cloning preserves the body and allows security headers to be applied. |
| **Symptoms if missing** | Uncaught exceptions or missing `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, or `X-Frame-Options` on OAuth/admin responses; intermittent 500s on middleware paths that set baseline headers. |
| **Remove when** | Middleware always receives mutable responses, or upstream applies baseline security headers before the response is frozen. |
| **Build logs** | No `found`/`applied` line; single `replace` per matching file. |

### 4. Return value from `setBaselineSecurityHeaders` call sites

| | |
|---|---|
| **What it fixes** | Changes middleware patterns from `setBaselineSecurityHeaders(response); return response;` to `return setBaselineSecurityHeaders(response);` (two indentation variants). |
| **Why needed** | Patch 3 makes `setBaselineSecurityHeaders` return a possibly cloned response; callers must return that value, not the original immutable reference. |
| **Symptoms if missing** | Security header clone from patch 3 is discarded; same immutable-header failures or missing headers as patch 3. |
| **Remove when** | Remove together with patch 3 when upstream handles writable responses correctly. |
| **Build logs** | No `found`/`applied` line. |

### 5. Publish `syncDataColumns` column-drift guard

| | |
|---|---|
| **What it fixes** | Wraps `await this.syncDataColumns(type, id, revision.data)` in try/catch and **ignores** errors whose message contains `no such column` or `unknown column`; rethrows all other errors. |
| **Why needed** | On publish, draft revision JSON can still contain keys for columns removed from `ec_*` tables (schema drift). `syncDataColumns` would otherwise hard-fail the publish. |
| **Symptoms if missing** | `content_publish` / EmDash admin publish fails with SQLite/Turso “no such column” (or “unknown column”) during publish; MCP returns opaque failure. |
| **Remove when** | EmDash publish path no longer calls `syncDataColumns` on stale keys, or migrations/revisions are cleaned so drift cannot occur; staging publishes consistently without the guard (see [ARCHITECTURE.md](../../ARCHITECTURE.md) deliverable §8.3). |
| **Build logs** | **Yes:** `publish syncDataColumns guard: found=…, applied=…`. `found` increments when the needle appears in a file; `applied` increments when the replacement actually changed content. |

### 6. MCP publish error diagnostics

| | |
|---|---|
| **What it fixes** | Replaces a generic `CONTENT_PUBLISH_ERROR` / `"Failed to publish content"` return with a message that includes the underlying error: `` `Failed to publish content: ${detail}` ``. |
| **Why needed** | Operators and agents calling MCP `content_publish` need the real failure reason in the tool response, not a fixed string. |
| **Symptoms if missing** | MCP publish failures only report `"Failed to publish content"` with no root cause; harder to debug in CI, Cursor MCP, or `emdash-mcp-tools-call.mjs`. |
| **Remove when** | Upstream EmDash MCP handler includes the caught error message in `CONTENT_PUBLISH_ERROR` responses by default. |
| **Build logs** | **Yes:** `publish error diagnostics: found=…, applied=…`. |

### 7. `env.ASSETS` null guards (`worker-entry_*` only)

| | |
|---|---|
| **What it fixes** | In files whose basename starts with `worker-entry_`: introduces `const assetsBinding = env.ASSETS`, guards all `env.ASSETS.fetch(...)` call sites with `assetsBinding` checks, and returns `404` from `prerenderedErrorPageFetch` when the binding is missing. |
| **Why needed** | Astro’s generated Worker entry assumes the `ASSETS` binding is always present. In some dev/preview or misconfigured deploy contexts the binding can be undefined; unguarded `.fetch` throws. |
| **Symptoms if missing** | Runtime `TypeError` (cannot read properties of undefined) when serving static assets, prerendered fallbacks, or error pages if `ASSETS` is not bound. |
| **Remove when** | `@astrojs/cloudflare` generates null-safe asset access, or the project guarantees `ASSETS` on every target environment where this entry runs. |
| **Build logs** | No `found`/`applied` line; only applied in `worker-entry_*.mjs` files. |

---

## Related docs

- Build pipeline and Wrangler configs: [../README.md](../README.md)
- EmDash publish / MCP workflow: [CONTENT_PROMOTION_RUNBOOK.md](../CONTENT_PROMOTION_RUNBOOK.md), [PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md](PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md)
- Architecture note on removing these patches: [ARCHITECTURE.md](../../ARCHITECTURE.md) (remaining decisions and deliverable §8.3)
