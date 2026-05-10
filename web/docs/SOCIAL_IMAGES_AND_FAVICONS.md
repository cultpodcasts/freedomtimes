# Social Images and Favicons

This document defines how Freedom Times generates social share images and favicon assets, and the metadata/tag practices we should follow.

## Goals

- Consistent social previews across X/Twitter, WhatsApp, Facebook, LinkedIn, Slack, etc.
- Predictable dimensions and typography.
- Keep generated social images under `600KB`.
- Keep favicon coverage complete (`.ico`, `.png`, `.svg`, Apple touch icon).

## Current image standards

- **Post social images:** `1200x675` PNG (generator script).
- **Homepage social image:** `1200x630` PNG (`web/public/social/homepage-og.png`).
- **Hard size target:** each generated social image should be `<= 600KB`.

## Metadata tags used

Tags are rendered in `web/src/layouts/Layout.astro`.

- Open Graph:
  - `og:site_name`
  - `og:type`
  - `og:title`
  - `og:description`
  - `og:url`
  - `og:image`
  - `og:image:secure_url`
  - `og:image:alt`
  - `og:image:width`
  - `og:image:height`
- Twitter/X:
  - `twitter:card`
  - `twitter:title`
  - `twitter:description`
  - `twitter:image`
  - `twitter:image:alt`

Notes:

- `og:image` values are absolute URLs at render time.
- `og:image:width` and `og:image:height` are configurable per page via `Layout` props.
- Posts pass `ogImageWidth={1200}` and `ogImageHeight={675}`.

## Post image generation

Script: `web/scripts/generate-social-images.ts`

What it does:

1. Fetches post data and featured image.
2. Composes social card with Satori + Resvg.
3. Applies PNG optimization pass (palette/compression attempts).
4. Enforces hard limit (`<= 600KB`), failing if still above threshold.
5. Uploads media to EmDash.
6. Persists **`seo.image`** as the **media row id string** returned by the upload API (`item.id`). EmDash types **`ContentSeo.image`** as **`string | null` only** — objects are rejected by REST validation; **`storageKey`** strings must not be stored here (after deduplicated uploads, the R2 key’s ULID differs from **`media.id`**). The **admin OG Image** picker resolves previews by **media id**. The **public site** resolves bare ids in **`resolveSocialImageSrc`** (Turso and/or **`/_emdash/api/media/:id`**). Writes use **`PUT /_emdash/api/content/posts/:slug`** with a partial body (`seo` only once `social_image` is removed from schema).
7. For **published** posts, **`POST …/publish`** only if there is a **pending draft** (`draftRevisionId` set). If the PUT applied with no separate draft, publish is **skipped** (calling publish with nothing pending returns 500 in current EmDash).

8. After **`--all`** completes, **orphan cleanup**: deletes **`image/png`** media whose **`filename`** ends with **`-social.png`** and whose **`id`** is **not** referenced by any post (`seo.image`, featured image, etc.). Use **`--no-cleanup-media`** to skip deletion.

**`updatedAt`:** EmDash advances this timestamp on successful content writes. There is **no supported** REST/MCP flag to keep the old value.

**Remove the legacy “Social Image” field from the schema** (stops the empty field in admin; **irreversible**, drops column data — run after posts use **`seo.image`**):

```powershell
cd web
npx --yes dotenv-cli -e "..\.env.dev" -- tsx scripts/generate-social-images.ts --all --drop-social-image-field
```

That calls MCP **`schema_delete_field`** for **`posts.social_image`**, then skips `data.social_image` in PUTs for that run.

Run for one post (slug only; uses `EMDASH_URL` / `EMDASH_STAGING_URL` and token from `..\.env.dev` or `~/.config/emdash/auth.json`):

```powershell
cd web
npx --yes dotenv-cli -e "..\.env.dev" -- tsx scripts/generate-social-images.ts building-the-cult-what-katie-simpsons-murder-reveals-about-coercive-control-group-dynamics-and-the-laws-that-should-have-saved-her
```

Regenerate **all draft and published** posts (upload + REST partial PUT + **`content_publish`** when published, unless `--no-publish`). Use after changing layout constants such as `SOCIAL_CLIENT_BOTTOM_TITLEBAR_RESERVE_PX`.

```powershell
cd web
npx --yes dotenv-cli -e "..\.env.dev" -- tsx scripts/generate-social-images.ts --all
```

Published-only (previous behaviour):

```powershell
tsx scripts/generate-social-images.ts --all --published-only
```

Example article title: *"Building the Cult": How the Law Failed Katie Simpson*. The headline stack is shifted up from the bottom by **`CONTENT_INSET_PX` + `SOCIAL_CLIENT_BOTTOM_TITLEBAR_RESERVE_PX`** in `web/scripts/generate-social-images.ts` so X/Twitter’s overlaid title bar is less likely to cover the last line; increase the reserve if a client still clips.

## Homepage social image

Source output:

- Final asset: `web/public/social/homepage-og.png`
- Working renderer: `web/scripts/render-homepage-og-preview.mjs`

Generate/regenerate:

```powershell
cd web
node scripts/render-homepage-og-preview.mjs
```

This script writes:

- `web/public/social/homepage-og.png` (used by homepage metadata)
- `web/public/social/homepage-og-preview.png` (local review artifact)

Homepage page binding:

- `web/src/pages/homepage.astro` uses:
  - `const socialImage = '/social/homepage-og.png';`

## Favicon generation

Script: `web/scripts/generate-favicons.mjs`

What it does:

- Fetches Playfair font.
- Renders branded glyph artwork.
- Outputs:
  - `web/public/favicon.ico` (multi-resolution)
  - `web/public/favicon.png`
  - `web/public/apple-touch-icon.png`

Run:

```powershell
cd web
node scripts/generate-favicons.mjs
```

## Required head links

In `Layout.astro`, keep:

```html
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```

## Validation checklist (before deploy)

1. Build succeeds:

```powershell
cd web
npx --yes dotenv-cli -e "..\.env.dev" -- npm run build
```

2. Verify generated file sizes:
   - Post social images in `.release` are under `600KB`.
   - `web/public/social/homepage-og.png` looks correct.
3. Confirm metadata output on a target page:
   - `og:image`, `og:image:width`, `og:image:height`
   - `twitter:image` and `twitter:card`
4. Re-test in validators/debuggers:
   - X Card Validator
   - Facebook Sharing Debugger
   - WhatsApp share preview (actual app/device check)

## Reference practices

- Open Graph image baseline and tag guidance:
  - [Open Graph image size and best practices](https://doinwp.com/og-image-size-and-requirements/)
- Meta sharing docs:
  - [Meta Sharing Best Practices](https://developers.facebook.com/docs/sharing/best-practices)
  - [Meta Image docs](https://developers.facebook.com/docs/sharing/webmasters/images/)
- X Cards:
  - [X Summary Card with Large Image](https://developer.x.com/en/docs/x-for-websites/cards/overview/summary-card-with-large-image)

## Operational notes

- For any batch operation that mutates CMS-backed content (`social_image` rewrites), perform a recoverable backup of target DB first.
- Prefer staging regeneration/audit first, then production rollout.
