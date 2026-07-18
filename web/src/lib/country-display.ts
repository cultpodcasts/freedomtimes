/**
 * Display helpers for ISO 3166-1 alpha-2 (and Cloudflare special) country codes
 * on the admin analytics UI: English name + flag emoji.
 */

export type CountryDisplay = {
  /** Normalized uppercase code used for lookup (e.g. GB, XX). */
  code: string;
  /** English display name (never empty). */
  name: string;
  /** Flag emoji when available; empty string when none (use with aria-hidden). */
  flag: string;
  /** Full accessible label (name only — do not rely on emoji alone). */
  ariaLabel: string;
  /** Tooltip with name + code for staff debugging / long-name hover. */
  title: string;
};

/** Cloudflare / legacy GeoIP codes that are not real ISO countries. */
const SPECIAL_COUNTRY_LABELS: Record<string, string> = {
  XX: 'Unknown',
  ZZ: 'Unknown',
  T1: 'Tor network',
  A1: 'Anonymous proxy',
  A2: 'Satellite provider',
  O1: 'Other proxy',
};

const displayNames =
  typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

function normalizeCountryCode(raw: string | null | undefined): string {
  const code = (raw ?? '').trim().toUpperCase();
  if (!code) {
    return 'XX';
  }
  return code;
}

/** Regional Indicator Symbol flag emoji for a two-letter A–Z code, else ''. */
export function countryCodeToFlagEmoji(code: string): string {
  const normalized = normalizeCountryCode(code);
  if (!/^[A-Z]{2}$/.test(normalized)) {
    return '';
  }
  // Skip non-territory Cloudflare specials — letters would still encode but mislead.
  if (normalized in SPECIAL_COUNTRY_LABELS) {
    return '';
  }
  const base = 0x1f1e6; // Regional Indicator Symbol Letter A
  const a = normalized.charCodeAt(0) - 65;
  const b = normalized.charCodeAt(1) - 65;
  if (a < 0 || a > 25 || b < 0 || b > 25) {
    return '';
  }
  return String.fromCodePoint(base + a, base + b);
}

function englishCountryName(code: string): string {
  const special = SPECIAL_COUNTRY_LABELS[code];
  if (special) {
    return special;
  }
  if (!/^[A-Z]{2}$/.test(code)) {
    return code || 'Unknown';
  }
  const fromIntl = displayNames?.of(code);
  if (fromIntl && fromIntl !== code) {
    return fromIntl;
  }
  return `Unknown (${code})`;
}

/**
 * Map a stored analytics country blob (ISO alpha-2 or Cloudflare XX/T1/…) to
 * English name + optional flag emoji for the admin UI.
 */
export function formatCountryDisplay(raw: string | null | undefined): CountryDisplay {
  const code = normalizeCountryCode(raw);
  const name = englishCountryName(code);
  const flag = countryCodeToFlagEmoji(code);
  const title = code === 'XX' && name === 'Unknown' ? 'Unknown country' : `${name} (${code})`;
  return {
    code,
    name,
    flag,
    ariaLabel: name,
    title,
  };
}
