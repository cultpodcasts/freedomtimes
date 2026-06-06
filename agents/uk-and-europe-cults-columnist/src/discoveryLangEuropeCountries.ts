import { readdirSync, readFileSync } from 'node:fs';

/** Strip discovery query quotes from terms like `"United Kingdom"`. */
export function stripDiscoveryCountryTerm(term: string): string {
  return term.replace(/^["'«»„""]+|["'«»„""]+$/g, '').trim();
}

function normalizeCountryToken(term: string): string {
  return stripDiscoveryCountryTerm(term).toLowerCase();
}

/** Per-locale `europeCountryOr` from `data/discovery/lang/<code>.json`. */
export function loadEuropeCountryOrByLanguageFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as {
      language?: unknown;
      europeCountryOr?: unknown;
    };
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : name.replace(/\.json$/i, '').toLowerCase();

    const terms = parsed.europeCountryOr;
    if (terms === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: europeCountryOr must be a string array when present`);
    }
    result[lang] = terms as string[];
  }

  return result;
}

/** Union of all country / region names — must not drive story clusters or cluster labels. */
export function loadUnionEuropeCountryOrTerms(): string[] {
  const tokens = new Set<string>();
  for (const terms of Object.values(loadEuropeCountryOrByLanguageFromDiscoveryLangFiles())) {
    for (const raw of terms) {
      const phrase = normalizeCountryToken(raw);
      if (!phrase) continue;
      tokens.add(phrase);
      for (const word of phrase.split(/\s+/)) {
        if (word.length >= 3) {
          tokens.add(word);
        }
      }
    }
  }
  return [...tokens];
}
