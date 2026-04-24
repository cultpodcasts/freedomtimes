# Freedom Times Design & Style Guide

This document defines the visual and structural principles for the Freedom Times platform. All future development and AI-assisted edits must adhere to these standards to maintain the "Broadsheet" aesthetic and professional integrity of the site.

## 1. Core Aesthetic: The Modern Broadsheet
The design is inspired by high-end investigative journalism and traditional newspapers (e.g., Financial Times, The Guardian). It prioritizes typography, whitespace, and structural clarity over decorative elements.

- **Minimalist**: No unnecessary borders, shadows, or gradients.
- **High Contrast**: Primary black text (`#111111`) on a pure white background (`#ffffff`).
- **Authority**: Use heavy-weight headings and refined serif body text to convey trust and seriousness.

## 2. Typography System
We use a curated set of Google Fonts. Consistency in weight and spacing is critical.

### Headings (Playfair Display)
- **Weight**: Always `900` for primary and secondary headlines.
- **Letter Spacing**: Tighter than default. Use `-0.015em` to `-0.02em`.
- **Line Height**: Very tight. `1` or `0.95`.
- **Sizing**: Use `clamp` for responsiveness. Site Header: `clamp(2.5rem, 7vw, 4.5rem)`. Article Headlines: `clamp(2rem, 4vw, 3.2rem)`.

### Body Text (Source Serif 4)
- **Usage**: Article content, story descriptions (deks), and abstracts.
- **Weight**: `400` (Regular) for content, `500` or `600` for emphasis.
- **Sizing**: Standard body `1.15rem`, story deks `1.1rem`.
- **Line Height**: `1.6` to `1.7` for readability.

### Metadata & Navigation (Inter)
- **Usage**: Dates, authors, navigation links, and "kickers" (section labels).
- **Weight**: `600` (Semi-bold) or `700` (Bold).
- **Casing**: Use **Natural Casing** (e.g., "Archives", not "ARCHIVES"). Avoid forced uppercase unless for small, tracked-out kickers.
- **Letter Spacing**: `0.02em` for navigation, `0.05em` to `0.1em` for small kickers.

## 3. Layout & Spacing
- **Max Widths**:
  - Main Grid/Homepage: `1200px`.
  - Article View: `900px` (ensures optimal characters-per-line for reading).
- **Padding**:
  - Top of Page: `3rem` (standardized across all templates).
  - Side Padding: `1.5rem` (mobile safety).
- **Grid Strategy**: Use CSS Grid for the homepage and archives. Maintain a clear "lead story" vs "rail" hierarchy.

## 4. UI Components
### The Masthead (Header.astro)
- Left-aligned brand and navigation.
- Includes a top "Edition" label (`Inter`, bold) and a "Tagline" (`Source Serif 4`, italic).
- Navigation links are black (`#111111`) and turn blue (`#0044bb`) only on hover or when active.

### The Global Footer (Footer.astro)
- Contains "About Us", "Contact Us", and "Privacy Policy".
- Simple, centered or left-aligned, separated from main content by a subtle border.

### The Login Gateway (index.astro)
- **Strict Privacy**: Must be absolutely minimal.
- No site branding, no header, no footer, no navigation.
- Pure white background with a single centered card.
- Message: "Secure Access".

## 5. Color Palette
- **Primary**: `#111111` (Black)
- **Secondary**: `#555555` (Gray)
- **Accent**: `#0044bb` (Deep Blue - used ONLY for links/active states)
- **Background**: `#ffffff` (White)
- **Border**: `#eeeeee` (Light Gray) or `#111111` (Heavy Black for masthead base)

## 6. CSS Best Practices
- Use global variables defined in `global.css` (e.g., `--max-width-main`, `--page-padding-top`).
- Avoid local `@import` for fonts; use the `<link>` tags in `Layout.astro`.
- Keep component styles scoped to the `.astro` file unless they are truly global.
