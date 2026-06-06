import { readdirSync, readFileSync } from 'node:fs';

/** Per-locale weak cult/sect/religion tokens from `data/discovery/lang/<code>.json` → `genericCultTerms`. */
export function loadGenericCultTermsByLanguageFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as {
      language?: unknown;
      genericCultTerms?: unknown;
    };
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : name.replace(/\.json$/i, '').toLowerCase();

    const terms = parsed.genericCultTerms;
    if (terms === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: genericCultTerms must be a string array when present`);
    }
    result[lang] = terms as string[];
  }

  return result;
}

/** Union of all locale generic cult/religion terms — must not drive clusters or cluster labels. */
export function loadUnionGenericCultTerms(): string[] {
  const tokens = new Set<string>();
  for (const terms of Object.values(loadGenericCultTermsByLanguageFromDiscoveryLangFiles())) {
    for (const raw of terms) {
      const phrase = raw.toLowerCase().replace(/^["'«»„""]+|["'«»„""]+$/g, '').trim();
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
