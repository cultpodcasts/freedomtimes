/**
 * Capacitor `App.getLaunchUrl()` returns the cold-start VIEW intent for the
 * entire process lifetime. Freedom Times pages re-run
 * `initializeNativeAuthBridge` on every full document load, so without a
 * durable guard the same magic-link verify URL is `location.replace`d again
 * after the operator navigates to `/admin` — burning the single-use token and
 * landing them on EmDash login.
 *
 * The same key also dedupes identical `appUrlOpen` deliveries. A *new* magic-link
 * URL (different `token=`) still claims successfully — only the exact prior
 * string is blocked.
 */

export const CAPACITOR_LAUNCH_URL_HANDLED_KEY = 'ft_capacitor_launch_url_handled';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Returns true when this open/launch URL should be navigated to (first time for
 * this exact string). Marks the URL handled in sessionStorage (same-origin
 * WebView navigations).
 */
export function claimCapacitorLaunchUrl(
  url: string,
  storage: StorageLike | null | undefined,
): boolean {
  if (!storage) {
    return true;
  }

  try {
    if (storage.getItem(CAPACITOR_LAUNCH_URL_HANDLED_KEY) === url) {
      return false;
    }
    storage.setItem(CAPACITOR_LAUNCH_URL_HANDLED_KEY, url);
    return true;
  } catch {
    // Private mode / blocked storage — fail open so cold-start still works.
    return true;
  }
}
