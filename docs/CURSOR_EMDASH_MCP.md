# Cursor EmDash MCP setup (Freedom Times)

Operator runbook for **freedomtimes-staging** and **freedomtimes-production** MCP servers in Cursor.

**Personal Cursor skill (auto-discovery):** `~/.cursor/skills/freedomtimes-emdash-mcp/SKILL.md` — use when MCP breaks after reload, reinstall, or multi-root workspace changes.

## Quick status check

**Ctrl+Shift+J → Tools & MCP** — both servers green, **51 tools enabled** each.

If red/missing: follow [Repair workflow](#repair-workflow) below. **AI agents:** see `AGENTS.md` Primary guardrails §1 — STOP if MCP unavailable; do not shell-fallback.

## Why not direct HTTP MCP?

On Windows + Cursor + EmDash, direct HTTP config in `mcp.json` often fails:

1. **`${env:EMDASH_*_PAT}` in headers** — Cursor may send the literal string, not the token.
2. **OAuth discovery** — EmDash exposes `/.well-known/oauth-*`; Cursor and stable `mcp-remote` try OAuth before bearer PAT (HTTP 500).
3. **Multi-root `workspaceFolder`** — `${workspaceFolder}/../freedomtimes/...` can resolve to the wrong root (e.g. Aberdeen Incident) when agents + articles + site are open together.

**Working pattern:** stdio bridge → local `mcp-remote@next` → EmDash HTTP with PAT.

## Architecture

```
Cursor (~/.cursor/mcp.json)
  └─ node emdash-mcp-cursor-bridge.mjs <staging|production>
       └─ mcp-remote@next (local, web/node_modules)
            └─ https://{staging|freedomtimes}.news/_emdash/api/mcp
                 Authorization: Bearer <PAT>
```

Bridge: `web/scripts/emdash-mcp-cursor-bridge.mjs`

Token resolution order:

1. `EMDASH_STAGING_PAT` / `EMDASH_PRODUCTION_PAT` (process env)
2. Windows User env vars (PowerShell lookup)
3. `~/.config/emdash/auth.json` from `npx emdash login`

## One-time setup

### 1. Dependencies

```powershell
cd $env:USERPROFILE\source\repos\freedomtimes\web
npm install
```

Requires `mcp-remote@next` in `web/package.json` devDependencies.

### 2. Tokens

```powershell
cd $env:USERPROFILE\source\repos\freedomtimes
.\scripts\set-emdash-mcp-tokens.ps1 -UseCurrentLoginTokens
```

Sets user-level `EMDASH_STAGING_PAT` and `EMDASH_PRODUCTION_PAT`.

### 3. Global Cursor config (Windows)

**File:** `%USERPROFILE%\.cursor\mcp.json` (Windows) or `~/.cursor/mcp.json` — **user-local, not committed.**

Use **literal paths** on your machine (see `~/.cursor/skills/freedomtimes-emdash-mcp/mcp.json.template`). Replace `<REPO_ROOT>` with your checkout path, e.g. `%USERPROFILE%\source\repos\freedomtimes`:

```json
{
  "mcpServers": {
    "freedomtimes-staging": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "<REPO_ROOT>/web/scripts/emdash-mcp-cursor-bridge.mjs",
        "staging"
      ]
    },
    "freedomtimes-production": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": [
        "<REPO_ROOT>/web/scripts/emdash-mcp-cursor-bridge.mjs",
        "production"
      ]
    }
  }
}
```

**Multi-root rule:** do **not** duplicate these servers in `freedomtimes-agents/.cursor/mcp.json` when Aberdeen Incident (or other roots) are in the same workspace. Use **one** global `~/.cursor/mcp.json`.

Portable template (variable paths — may work on single-root): `.cursor/mcp.json` in this repo.

### 4. Reload

**Developer: Reload Window**, then enable servers in **Tools & MCP** if needed.

## Repair workflow

When MCP breaks after Cursor update, reload, or workspace change:

1. Confirm `web/node_modules/mcp-remote/dist/proxy.js` exists → `cd web && npm install`
2. Confirm PATs: `[Environment]::GetEnvironmentVariable('EMDASH_STAGING_PAT','User')` returns `ec_pat_...`
3. Confirm global `~/.cursor/mcp.json` has **literal** `node.exe` + bridge script paths
4. Remove duplicate `mcp.json` server entries from other workspace roots
5. Reload window; check **Output → MCP Logs**
6. Terminal smoke test:

```powershell
& "C:\Program Files\nodejs\node.exe" "$env:USERPROFILE\source\repos\freedomtimes\web\scripts\emdash-mcp-cursor-bridge.mjs" staging
```

Expect `Proxy established successfully` (Ctrl+C to stop).

## Copilot / VS Code

`/.vscode/mcp.json` uses the `servers` key and HTTP URLs — reference for Copilot. Cursor on Windows should use the **stdio bridge** above.

## Related docs

| Doc | Topic |
|-----|--------|
| `AGENTS.md` | MCP-only guardrail for AI agents |
| `AGENTS.md` Primary guardrails §8 | Large media: never MCP `media_upload` base64 |
| `web/docs/DEPLOY.md` | Canonical deploy reference + symptom index (links here) |
| `web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md` | MCP vs CLI for Portable Text |
| `web/docs/SOCIAL_IMAGES_AND_FAVICONS.md` | Official OG card sizes and `generate-social-images.ts` |
| `scripts/set-emdash-mcp-tokens.ps1` | PAT env var setup |

## Large media uploads (avoid MCP base64 truncation)

**Hard rule:** for official OG/social PNGs and any other large media (typically **200–600KB**), **do not** send file bytes through Cursor MCP `media_upload` `base64`. That path truncates, times out, or uploads a 1×1 test file. The R2 **MEDIA** binding has **no signed upload URLs** — ignore the `media_upload` tool text that tells agents to send `base64`, and ignore `media_create` text that assumes a signed URL.

This wasted hours on the **23 Aug 2026** weekly when agents followed MCP `base64` for official cards, then JPEG-crushed the result.

### Forbidden

- MCP **`media_upload`** with **`base64`** (or a homemade public URL) for official / large cards
- **JPEG-crushing** official `generate-social-images.ts` / `draft:push-staging` PNGs to “make them small enough for MCP”
- **Homemade** OG/social cards (canvas, screenshot, AI image, hand-composited JPEG) in place of the official script
- Setting **`seo.image`** to a **bare media id** (validates; admin OG Image widget stays empty) or a raw **`storageKey`** without the `/_emdash/api/media/file/` prefix

### Correct path

1. **Generate** the card with the official script only: **`web/scripts/generate-social-images.ts`** (also invoked from sibling **freedomtimes-agents** `draft:push-staging`). Do not invent a substitute card.
2. **Put bytes** with the existing CLI exception for binary — **`emdash media upload`** — or **`POST /_emdash/api/media`** multipart (same as `uploadMedia` in `generate-social-images.ts`). Admin / raw R2 put is a last resort. Schema and post JSON stay MCP-only (`AGENTS.md` §3).
3. **Library row:** if `emdash media upload` or the multipart POST already returned a row, read **`storageKey`** / **`storage_key`** from it (the filename-bearing R2 key, not the bare library `id`). After a raw R2 put with no library row, MCP **`media_create`**. If the row exists and you only need metadata, MCP **`media_update`**.
4. **Point the post at the card:** MCP **`content_update`** with **`seo.image`** set to the same-origin file path **`/_emdash/api/media/file/<storageKey>`**. That is what `seoImageFieldValueFromNormalizedRow` writes and what the admin OG Image widget displays. A **bare media id** validates but leaves the picker empty. Do **not** store a raw `storageKey` without the `/_emdash/api/media/file/` prefix, and do **not** send a MediaReference object (`ContentSeo.image` is `string | null` only).

### Staging upload example (PowerShell)

From the **repo root**, after `emdash login` (or with staging URL + token in the environment):

```powershell
npx --prefix web emdash media upload .\web\.release\<slug>-social.png --alt "Share preview" -u $env:EMDASH_STAGING_URL -t $env:EMDASH_STAGING_TOKEN --json
```

Read **`storageKey`** / **`storage_key`** from the JSON (not the bare `id`). Then MCP `content_update`:

```json
{
  "collection": "posts",
  "id": "<slug>",
  "seo": { "image": "/_emdash/api/media/file/<storageKey>" }
}
```

Staging example that worked **23 Aug 2026**: `seo.image` = `/_emdash/api/media/file/01M0QT8Y0RP9SEZSKVMHXBYEXQ.png`.

If MCP is unavailable, **STOP** (`AGENTS.md` Primary guardrails §1). Do **not** fall back to MCP `media_upload` base64, JPEG-crush, or a homemade card.
