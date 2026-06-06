import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Strip discovery-style quotes from terms. */
export function stripClusterModifierTerm(term: string): string {
  return term.replace(/^["'«»„""]+|["'«»„""]+$/g, '').trim();
}

export function normalizeClusterModifierToken(term: string): string {
  return stripClusterModifierTerm(term).toLowerCase();
}

export type ClusterModifierLexicon = {
  language: string;
  terms: string[];
};

function parseModifierFile(name: string, parsed: unknown): ClusterModifierLexicon {
  const lang = name.replace(/\.json$/i, '').toLowerCase();
  if (lang.startsWith('_')) {
    throw new Error(`unexpected modifier file: ${name}`);
  }

  if (Array.isArray(parsed)) {
    return { language: lang, terms: parsed.filter((t) => typeof t === 'string') as string[] };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { language: lang, terms: [] };
  }

  const record = parsed as { language?: unknown; terms?: unknown };
  const language =
    typeof record.language === 'string' && record.language.trim()
      ? record.language.trim().toLowerCase()
      : lang;

  const terms = record.terms;
  if (terms === undefined) {
    return { language, terms: [] };
  }
  if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) {
    throw new Error(`data/discovery/cluster-modifiers/${name}: terms must be a string array`);
  }
  return { language, terms: terms as string[] };
}

/** Per-locale modifier lexicon from `data/discovery/cluster-modifiers/<code>.json`. */
export function loadClusterModifierTermsByLanguage(): Record<string, string[]> {
  const dirUrl = new URL('../data/discovery/cluster-modifiers/', import.meta.url);
  const dirPath = fileURLToPath(dirUrl);
  if (!existsSync(dirPath)) {
    return {};
  }

  const names = readdirSync(dirPath).filter((n) => n.endsWith('.json') && !n.startsWith('_'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, dirUrl);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as unknown;
    const { language, terms } = parseModifierFile(name, parsed);
    result[language] = terms;
  }

  return result;
}

/** @deprecated Use loadClusterModifierTermsByLanguage — kept for script migration only. */
export function loadClusterModifierTermsByLanguageFromDiscoveryLangFiles(): Record<string, string[]> {
  const langDirUrl = new URL('../data/discovery/lang/', import.meta.url);
  const names = readdirSync(langDirUrl).filter((n) => n.endsWith('.json'));
  const result: Record<string, string[]> = {};

  for (const name of names) {
    const fileUrl = new URL(name, langDirUrl);
    const parsed = JSON.parse(readFileSync(fileUrl, 'utf-8')) as {
      language?: unknown;
      clusterModifierTerms?: unknown;
    };
    const lang =
      typeof parsed.language === 'string' && parsed.language.trim()
        ? parsed.language.trim().toLowerCase()
        : name.replace(/\.json$/i, '').toLowerCase();

    const terms = parsed.clusterModifierTerms;
    if (!Array.isArray(terms)) continue;
    result[lang] = terms.filter((t) => typeof t === 'string') as string[];
  }

  return result;
}

/** Union of all locale modifier terms — for cross-language cluster filtering. */
export function loadUnionClusterModifierTerms(): string[] {
  const tokens = new Set<string>();
  for (const terms of Object.values(loadClusterModifierTermsByLanguage())) {
    for (const raw of terms) {
      const phrase = normalizeClusterModifierToken(raw);
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
