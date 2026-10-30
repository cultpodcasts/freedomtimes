# Post-build Cloudflare bundle patches

`web/scripts/patch-cloudflare-bundle.ts` runs as the **last step** of `npm run build`, after `astro build`
and `npm run test`:

```text
astro check && … && astro build && npm run test && tsx scripts/patch-cloudflare-bundle.ts
```

It reads every `**/*.mjs` file under `dist/server/` and applies the registry in
[`web/scripts/lib/cloudflare-bundle-patches.mjs`](../scripts/lib/cloudflare-bundle-patches.mjs). The
registry is the source of truth for which patches exist, their status and their reasons; this page explains
how to read it and what to do when it fails. If `dist/server` is missing, the script exits **1**.

---

## How the registry works

Every patch has a `status`:

| Status | Meaning | Build behaviour |
|---|---|---|
| `required` | The upstream bug is still present; the fix must ship. | The target must be found **exactly** `expectMatches` times across `dist/server` (counting already-patched copies via `appliedMarker`, so re-runs are idempotent). Otherwise the build **fails** (exit 1). |
| `obsolete` | Fixed upstream or the code path is gone; the patch is **not** applied. | Pinned to the package range it was verified against (`verifiedRange`, e.g. emdash `>=1.3.1 <1.4`). The build **fails** if the installed package is outside that range, or if the old buggy code (`regressionNeedle`) reappears in the bundle. |

There is no silent skip any more: a missing target or an unverified upgrade is a build failure, not a
`patched 0 file(s)` line.

### Current registry (emdash 1.4.0, `@astrojs/cloudflare` 14.4.3; obsolete emdash entries re-checked against 1.4.0 and verified `>=1.3.1 <1.5`)

| ID | Status | Why |
|---|---|---|
| `publish-error-diagnostics` | required (`expectMatches: 1`) | EmDash's content publish handler returns a bare `"Failed to publish content"`. The patch appends the caught error message so MCP `content_publish` / admin publish failures are diagnosable. Remove when upstream includes the error detail. |
| `oauth-csrf-cookie-path` | obsolete | Upstream sets the CSRF cookie with `Path=/_emdash/oauth/authorize`. |
| `baseline-security-headers-writable-response` | obsolete | `setBaselineSecurityHeaders()` no longer exists; EmDash middleware clones the response before setting headers. (This also covers the old "return value from `setBaselineSecurityHeaders` call sites" patch.) |
| `publish-syncdatacolumns-drift-guard` | obsolete | Publish no longer calls `syncDataColumns()`; it filters revision data with `keepKnownFields`, so dropped columns cannot cause "no such column". |
| `worker-entry-assets-guard` | obsolete | `@astrojs/cloudflare` 14 removed the `worker-entry_` chunk; `ASSETS` is bound by `assets.binding` in `web/wrangler.jsonc` (checked by `verify-worker-placement.mjs`). |
| `create-require-import-meta-url` | obsolete | No server chunk calls `createRequire(import.meta.url)`; the build-time occurrence is handled by `scripts/patch-emdash-windows-createrequire.mjs`. |

The exact `reason`, `regressionNeedle` and `verifiedRange` for each entry are in the registry file.

---

## Build log output

| Log line | Meaning |
|---|---|
| `[patch-cloudflare-bundle] required <id>: matched=N present=M OK` | `matched` = fresh rewrites in this run, `present` = patched copies now in the bundle. `OK` when `present` equals `expectMatches`. |
| `[patch-cloudflare-bundle] obsolete <id>: still obsolete` | Installed version is inside `verifiedRange` and the regression needle is absent. |
| `[patch-cloudflare-bundle] obsolete <id>: NEEDS REVIEW` | Followed by an `ERROR` line; the build fails. |
| `[patch-cloudflare-bundle] patched N file(s) (emdash X, @astrojs/cloudflare Y)` | Files rewritten in this run. A fresh build logs `patched 1 file(s)`. `patched 0 file(s)` is normal **only** on a re-run over an already patched `dist/server` (the required line then shows `matched=0 present=1 OK`). |
| `[patch-cloudflare-bundle] ERROR …` | Build exits **1**. Never noise: follow the procedure below. |

---

## When the build fails, or after bumping `emdash` / `@astrojs/cloudflare`

Re-verify, do not just widen ranges:

1. **Required patch `MISSING`** (`present` ≠ `expectMatches`): open the new bundle (`web/dist/server/chunks/*.mjs`)
   and the package source (`web/node_modules/emdash/dist/…`). If the bug is still there, update `pattern` /
   `appliedMarker` in the registry. If upstream fixed it, change the entry to `obsolete` with a `reason`, a
   `regressionNeedle` (the old buggy code) and the `verifiedRange` you checked.
2. **Obsolete patch outside `verifiedRange`:** for each such entry, check that the `reason` still holds in the
   new version (search the bundle and `node_modules` for the old code and the upstream fix). Only then move
   `verifiedRange` to the new version.
3. **Obsolete patch `regressionNeedle` found:** the old code is back. Restore the patch as `required` (the
   original replacement is in git history of `web/scripts/patch-cloudflare-bundle.ts`).
4. Update [`web/scripts/test-cloudflare-bundle-patches.mts`](../scripts/test-cloudflare-bundle-patches.mts)
   (runs in `npm test`) and the table above, then run `npm run build` again until there is no `ERROR`.
5. For the remaining required patch, smoke-test on staging that a failing MCP `content_publish` returns
   `Failed to publish content: <detail>`.

---

## Related docs

- Build pipeline and Wrangler configs: [../README.md](../README.md)
- EmDash publish / MCP workflow: [CONTENT_PROMOTION_RUNBOOK.md](../CONTENT_PROMOTION_RUNBOOK.md), [PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md](PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md)
- Open work: [ARCHITECTURE.md](../../ARCHITECTURE.md) (remaining decision 1, deliverable §8.3)
