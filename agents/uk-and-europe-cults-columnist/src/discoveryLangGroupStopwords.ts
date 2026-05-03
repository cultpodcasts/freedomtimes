import { readdirSync, readFileSync } from 'node:fs';

/** Editorial cluster phrase stopwords from `data/discovery/lang/<code>.json` → `groupStopwords`. */
export function loadGroupStopwordsByLanguageFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as {
      language?: unknown;
      groupStopwords?: unknown;
    };
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : name.replace(/\.json$/i, '').toLowerCase();

    const words = parsed.groupStopwords;
    if (words === undefined) {
      result[lang] = [];
      continue;
    }
    if (!Array.isArray(words) || !words.every((t) => typeof t === 'string')) {
      throw new Error(`data/discovery/lang/${name}: groupStopwords must be a string array when present`);
    }
    result[lang] = words as string[];
  }

  return result;
}
