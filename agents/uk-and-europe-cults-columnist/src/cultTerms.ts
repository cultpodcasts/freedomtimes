import { readFileSync } from 'node:fs';

type CultTermsConfig = {
  [language: string]: unknown;
};

function loadCultTermsByLanguageRaw(): Record<string, string[]> {
  const configUrl = new URL('../cult-terms.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as CultTermsConfig;
  const validEntries = Object.entries(parsed).filter(([language, terms]) => {
    return typeof language === 'string' && Array.isArray(terms) && terms.every((term) => typeof term === 'string');
  });

  const loaded = Object.fromEntries(validEntries) as Record<string, string[]>;
  if (Object.keys(loaded).length === 0) {
    throw new Error('cult-terms.json must include at least one language with string terms');
  }

  return loaded;
}

const CULT_TERMS_BY_LANGUAGE_RAW = loadCultTermsByLanguageRaw();

const LANGUAGE_ALIASES: Record<string, string> = {
  nb: 'no',
  nn: 'no',
  no: 'no',
};

/** BCP-47 base language for cult-term lookups (aliases e.g. nb → no). */
export function normalizeCultLanguageCode(language: string | undefined): string {
  if (!language) {
    return 'en';
  }

  const lowered = language.toLowerCase().trim();
  const base = lowered.split('-')[0] ?? lowered;
  return LANGUAGE_ALIASES[base] ?? base;
}

export const CULT_TERMS_BY_LANGUAGE: Record<string, string[]> = Object.fromEntries(
  Object.entries(CULT_TERMS_BY_LANGUAGE_RAW).map(([lang, terms]) => [lang, Array.from(new Set(terms))]),
);

export const ALL_CULT_TERMS = Array.from(new Set(Object.values(CULT_TERMS_BY_LANGUAGE).flat()));

export function getCultTermsForLanguage(language: string | undefined): string[] {
  const normalized = normalizeCultLanguageCode(language);
  const englishTerms = CULT_TERMS_BY_LANGUAGE.en ?? [];
  const localTerms = CULT_TERMS_BY_LANGUAGE[normalized] ?? englishTerms;

  // Keep English as fallback because some non-English feeds publish occasional English headlines.
  if (normalized === 'en') {
    return localTerms;
  }

  return Array.from(new Set([...localTerms, ...englishTerms]));
}
