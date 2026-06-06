/** Kaikki raw enwiktionary extract (stream line-by-line; do not commit). */
export const KAIKKI_RAW_JSONL_GZ_URL =
  'https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz';

/** POS tags treated as non-noun headline modifiers for cluster filtering. */
export const KAIKKI_MODIFIER_POS = new Set(['adj', 'adv', 'det', 'article']);

/** Default cap per locale — keeps committed JSON small and runtime sets bounded. */
export const DEFAULT_MAX_TERMS_PER_LOCALE = 2000;

/** Our discovery locale code → Kaikki/Wiktionary lang_code values. */
export const DISCOVERY_LOCALE_TO_KAIKKI_LANG: Record<string, string> = {
  en: 'en',
  fr: 'fr',
  de: 'de',
  es: 'es',
  it: 'it',
  pt: 'pt',
  nl: 'nl',
  pl: 'pl',
  da: 'da',
  sv: 'sv',
  no: 'no',
  fi: 'fi',
  cs: 'cs',
  sk: 'sk',
  hu: 'hu',
  ro: 'ro',
  el: 'el',
  hr: 'hr',
  sl: 'sl',
  sr: 'sr',
  bs: 'bs',
  mk: 'mk',
  uk: 'uk',
  bg: 'bg',
  sq: 'sq',
  et: 'et',
  lt: 'lt',
  lv: 'lv',
  is: 'is',
  mt: 'mt',
};

export function discoveryLocales(): string[] {
  return Object.keys(DISCOVERY_LOCALE_TO_KAIKKI_LANG).sort();
}
