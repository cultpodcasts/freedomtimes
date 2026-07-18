/**
 * Capacitor `App.getLaunchUrl()` returns the cold-start VIEW intent for the
 * entire process lifetime. Freedom Times pages re-run
 * `initializeNativeAuthBridge` on every full document load, so without a
 * durable guard the same magic-link verify URL is `location.replace`d again
 * after the operator navigates to `/admin` — burning the single-use token and
 * landing them on EmDash login.
 *
 * Magic-link opens have several equivalent URLs (HTTPS lander, HTTPS verify,
 * custom-scheme deep link). Claiming only the exact open string is not enough:
 * App Link → lander → lander JS verifies once → EmDash loads the bridge →
 * `getLaunchUrl()` still returns the *lander* URL → bridge maps it to verify
 * again → `invalid_link`. Mark every alias for the same token when handling.
 */

import {
  MAGIC_LINK_VERIFY_PATH,
  resolveAndroidMagicLinkHttpsUrl,
  resolveMagicLinkLanderToHttpsVerify,
  toAndroidMagicLinkDeepLink,
  toAndroidMagicLinkLanderUrl,
} from './native-android-magic-link';

export const CAPACITOR_LAUNCH_URL_HANDLED_KEY = 'ft_capacitor_launch_url_handled';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function readHandledSet(storage: StorageLike): Set<string> {
  const raw = storage.getItem(CAPACITOR_LAUNCH_URL_HANDLED_KEY);
  if (!raw) {
    return new Set();
  }

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((item): item is string => typeof item === 'string'));
      }
    } catch {
      // fall through — treat as a single legacy URL string
    }
  }

  return new Set([raw]);
}

function writeHandledSet(storage: StorageLike, handled: Set<string>): void {
  storage.setItem(CAPACITOR_LAUNCH_URL_HANDLED_KEY, JSON.stringify([...handled]));
}

/**
 * Collect lander / verify / deep-link URL strings that represent the same
 * single-use magic-link token. Non-magic-link URLs return `[url]` only.
 */
export function collectMagicLinkLaunchAliases(
  url: string,
  fallbackOrigin: string,
): string[] {
  const aliases = new Set<string>([url]);

  const fromLander = resolveMagicLinkLanderToHttpsVerify(url, fallbackOrigin);
  const fromDeep = resolveAndroidMagicLinkHttpsUrl(url, fallbackOrigin);
  const httpsVerify = fromLander ?? fromDeep;

  if (httpsVerify) {
    aliases.add(httpsVerify);
    const lander = toAndroidMagicLinkLanderUrl(httpsVerify);
    if (lander) {
      aliases.add(lander);
    }
    const deep = toAndroidMagicLinkDeepLink(httpsVerify);
    if (deep) {
      aliases.add(deep);
    }
    return [...aliases];
  }

  // Direct HTTPS verify App Link (desktop email / adb).
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === 'https:'
      && parsed.pathname === MAGIC_LINK_VERIFY_PATH
      && parsed.searchParams.get('token')
    ) {
      const lander = toAndroidMagicLinkLanderUrl(parsed.toString());
      if (lander) {
        aliases.add(lander);
      }
      const deep = toAndroidMagicLinkDeepLink(parsed.toString());
      if (deep) {
        aliases.add(deep);
      }
    }
  } catch {
    // keep [url]
  }

  return [...aliases];
}

/** Record URLs as already handled (lander JS before `location.replace`). */
export function markCapacitorLaunchUrlsHandled(
  urls: readonly string[],
  storage: StorageLike | null | undefined,
): void {
  if (!storage || urls.length === 0) {
    return;
  }

  try {
    const handled = readHandledSet(storage);
    for (const url of urls) {
      if (url) {
        handled.add(url);
      }
    }
    writeHandledSet(storage, handled);
  } catch {
    // Private mode / blocked storage — ignore.
  }
}

/**
 * Returns true when this open/launch URL should be navigated to (first time for
 * this URL or any magic-link alias). Marks all aliases handled in sessionStorage.
 */
export function claimCapacitorLaunchUrl(
  url: string,
  storage: StorageLike | null | undefined,
  options?: { fallbackOrigin?: string },
): boolean {
  if (!storage) {
    return true;
  }

  try {
    const fallbackOrigin = options?.fallbackOrigin ?? 'https://freedomtimes.news';
    const aliases = collectMagicLinkLaunchAliases(url, fallbackOrigin);
    const handled = readHandledSet(storage);

    if (aliases.some((alias) => handled.has(alias))) {
      return false;
    }

    for (const alias of aliases) {
      handled.add(alias);
    }
    writeHandledSet(storage, handled);
    return true;
  } catch {
    // Private mode / blocked storage — fail open so cold-start still works.
    return true;
  }
}
