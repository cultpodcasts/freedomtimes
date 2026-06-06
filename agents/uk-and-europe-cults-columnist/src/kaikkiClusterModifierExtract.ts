import { KAIKKI_MODIFIER_POS } from './kaikkiClusterModifierConfig.ts';
import { normalizeClusterModifierToken } from './discoveryLangClusterModifiers.ts';

export type KaikkiEntry = {
  word?: unknown;
  lang_code?: unknown;
  pos?: unknown;
  forms?: unknown;
  tags?: unknown;
};

export function isValidModifierLemma(word: string): boolean {
  const w = word.trim();
  if (w.length < 3 || w.length > 24) return false;
  if (/\d/.test(w)) return false;
  if (/\s/.test(w)) return false;
  if (!/^[\p{L}][\p{L}\p{M}'-]*$/u.test(w)) return false;
  return true;
}

function entryTags(entry: KaikkiEntry): string[] {
  if (!Array.isArray(entry.tags)) return [];
  return entry.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
}

/** Skip proper names and obvious noun-only POS even if mis-tagged. */
export function shouldSkipKaikkiEntry(entry: KaikkiEntry): boolean {
  const pos = typeof entry.pos === 'string' ? entry.pos.toLowerCase() : '';
  if (!KAIKKI_MODIFIER_POS.has(pos)) return true;
  const tags = entryTags(entry);
  if (tags.some((t) => t.includes('proper') || t === 'name')) return true;
  return false;
}

export function lemmasFromKaikkiEntry(entry: KaikkiEntry): string[] {
  if (shouldSkipKaikkiEntry(entry)) return [];
  const lemmas: string[] = [];
  if (typeof entry.word === 'string' && isValidModifierLemma(entry.word)) {
    lemmas.push(entry.word);
  }
  if (Array.isArray(entry.forms)) {
    for (const raw of entry.forms) {
      if (!raw || typeof raw !== 'object') continue;
      const form = (raw as { form?: unknown }).form;
      if (typeof form === 'string' && isValidModifierLemma(form)) {
        lemmas.push(form);
      }
    }
  }
  return lemmas;
}

/** Prefer shorter lemmas when capping — common headline modifiers tend to be short. */
export function capModifierTerms(terms: Iterable<string>, maxTerms: number): string[] {
  const unique = new Set<string>();
  for (const raw of terms) {
    const key = normalizeClusterModifierToken(raw);
    if (!key || !isValidModifierLemma(key)) continue;
    unique.add(key);
  }
  return [...unique]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, maxTerms);
}

export function mergeModifierTermLists(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing.map(normalizeClusterModifierToken));
  const merged = [...existing];
  for (const term of additions) {
    const key = normalizeClusterModifierToken(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }
  return merged;
}
