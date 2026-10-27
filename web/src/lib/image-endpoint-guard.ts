/**
 * `/_image` guard while the Cloudflare Images (`IMAGES`) binding is NOT bound.
 *
 * `@astrojs/cloudflare` (default `imageService: 'cloudflare-binding'`) routes
 * `/_image` to EmDash's `@emdash-cms/cloudflare/image-endpoint`:
 * - EmDash media hrefs (`/_emdash/api/media/file/<key>`) are read from R2 and,
 *   with no IMAGES binding, served as the original. That path is fine.
 * - Every other href is delegated to the adapter's `image-transform-endpoint`,
 *   which calls `env.IMAGES.input(...)` and throws a TypeError when IMAGES is
 *   unbound (today masked as a 404 by Astro's `/500` → `[slug].astro` lookup).
 *
 * Binding IMAGES has billing implications (Cloudflare Images transforms), which
 * is Jon's decision, so we do not bind it. Switching the build to
 * `imageService: 'passthrough'` is NOT a fix either: EmDash then stops wrapping
 * `/_image`, and media hrefs (admin media grid thumbnails) regress 200 → 404.
 *
 * Instead the middleware serves the adapter's passthrough endpoint (original
 * bytes via ASSETS; remote/cross-origin → 403, missing → 404) for exactly the
 * requests EmDash would delegate to the throwing transform endpoint. If IMAGES
 * is ever bound, the guard turns itself off and nothing else changes.
 *
 * Kept in sync with: web/scripts/test-image-endpoint-guard.mts and
 * web/scripts/test-wrangler-binding-drift.mts (IMAGES allow-list entry).
 */

export const IMAGE_ENDPOINT_PATH = '/_image';

export type ImageEndpointGuardInput = {
  method: string;
  pathname: string;
  /** Raw `href` query value (may be null). */
  href: string | null;
  /** Whether `env.IMAGES` (Cloudflare Images binding) is present. */
  hasImagesBinding: boolean;
  /**
   * EmDash's own matcher (`matchInternalMediaKey` from `emdash/media/image-endpoint`):
   * returns a key when EmDash will serve the href from R2 itself.
   */
  matchEmDashMediaKey: (href: string | null) => string | null;
};

export function isImageEndpointPath(pathname: string): boolean {
  return pathname === IMAGE_ENDPOINT_PATH || pathname === `${IMAGE_ENDPOINT_PATH}/`;
}

/**
 * True when the request would reach the adapter's IMAGES-binding transform
 * endpoint without a binding (and so throw). Missing `href` stays with the
 * stock endpoint (it returns 400/403 before touching IMAGES).
 */
export function shouldServeImageOriginal(input: ImageEndpointGuardInput): boolean {
  if (input.hasImagesBinding) return false;
  if (input.method !== 'GET' && input.method !== 'HEAD') return false;
  if (!isImageEndpointPath(input.pathname)) return false;
  if (!input.href) return false;
  return input.matchEmDashMediaKey(input.href) === null;
}
