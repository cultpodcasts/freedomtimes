# Editorial style: English copy for a global audience (French context)

Use this for **Freedom Times** pieces that cite French media, institutions, or untranslated French terms. Goal: an **English-speaking reader** who does not follow France day-to-day still knows **what a name is**, **why it matters**, and **what is at stake**.

---

## 0. Typography (Freedom Times English articles)

- Do not use bold: no markdown `**…**`, no HTML `<strong>`, and no Portable Text `strong` marks in article body or excerpt (calmer typographic voice).
- Italics are fine: `<em>`, markdown `*…*`, and PT `em` marks for light emphasis, titles of works, and glosses.

---

## 1. Hoist stakes in the opening (do not bury the “why it matters”)

After the human lede, add **one short paragraph** (or extend the **excerpt**) that answers, in plain English:

- **What is being alleged** (at the right level of generality; distinguish **allegations** from **findings**).
- **Why the story matters beyond gossip** (e.g. enforcement, professional rules, institutional accountability, protection of children, independence of justice from privilege).
- **That investigations and broadcasts are not courts** — avoid implying a verdict.

Readers should not have to scroll to a later section to understand **impact**.

---

## 2. French outlets and brands (first mention)

Use **name + role** on **first substantive mention** in the body (excerpt counts if the outlet appears there).

| Name | Gloss (pick one length to fit tone) |
|------|-------------------------------------|
| **France Inter** | *France Inter* (major **French public radio** station; **Radio France**) |
| **France Info** / *franceinfo* | **France Info** (France’s **rolling public news** service; **Radio France**) — prefer **France Info** in copy; retain *franceinfo* in URLs only. |
| **France 3 Régions** | **France 3 Régions** (regional **public television**, **France Télévisions**) |
| **ARTE** | **ARTE** (Franco-German **public broadcaster**) |
| **Libération** | **Libération** (major **French daily** newspaper) — optional if context is obvious |
| **La Tribune Dimanche** | **La Tribune Dimanche** (Sunday **opinion** section of the French business daily **La Tribune**) |

**France Inter vs France Info:** *Inter* = broad news, culture, and in-depth programmes; **France Info** = continuous news wire style. One clause is enough.

---

## 3. Other French terms (general rule)

1. **First use:** short gloss in **parentheses** or an **appositive**: *the **Conseil d’État** (France’s highest administrative court)*.
2. **Bodies and acronyms:** *the **CNIL** (France’s data-protection authority)*.
3. **Legal “bar”:** in English, **“the bar”** usually means the **legal profession**, not a café — gloss if ambiguity is likely (*lawyers’ professional body*, *disciplinary proceedings for lawyers*).
4. **Longer explanations:** use a **translate** / expandable block (see `web/src/lib/content/translateDetails.ts` and PT handling in `contentBlocks.ts`) so the lede stays clean.

---

## 4. Checklist before publish

- [ ] Excerpt states **stakes** (allegations vs law, institutions, public interest).
- [ ] **France Inter** and **France Info** (and other cited outlets) glossed on first pass.
- [ ] **Allegations** framed without **prejudging** outcomes.
- [ ] URLs may stay French-domain; **visible labels** use the English-forward names above.

---

## Portable Text: `audio` vs `video` embeds

- **`_type: "video"`** (`Video.astro`) — **Video**: YouTube / watch URLs, generic video iframes, or `<video>` for direct media files under EmDash.
- **`_type: "audio"`** (`Audio.astro`) — **Audio / podcast players**: Apple Podcasts (`embed.podcasts.apple.com`), Spotify embed URLs, other `https` iframe players, or `<audio>` for direct `.mp3` / `.m4a` / etc. Do **not** use `video` for podcast web players.

Fields (both): typically **`url`**, **`alt`** (or `title` for `Audio` fallback). Optional **`aspectRatio`** applies only to **`video`**.

---

## Applying edits to staging (Portable Text)

1. Export the **current** live `data` (MCP `content_get` or admin) so `content` is not shorter than production reality.
2. Edit the tracked patch under **`web/.emdash/article-patches/<slug>.json`** (`slug` + `data` object).
3. Run **`node web/scripts/merge-staging-post-from-patch.mjs posts <slug>`** (uses MCP for `_rev`, merges `data`, then `emdash content update` + `publish` on staging). The script **refuses** if the patch has **fewer** `content` blocks than live unless **`MERGE_STAGING_ALLOW_CONTENT_SHRINK=1`**.

---

## Related docs

- **`web/CONTENT_PROMOTION_RUNBOOK.md`** — promotion, UTF-8, backups.
- **`web/docs/PLAN_EMDASH_CONTENT_FORMAT_AND_MCP_HANDOFF.md`** — Portable Text and MCP as source of truth for `posts.content`.
