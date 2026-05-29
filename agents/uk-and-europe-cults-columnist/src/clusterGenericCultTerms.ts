import { ALL_GENERIC_CULT_TERMS } from './pipelineTerms.ts';
import { buildUnionClusterStopwordSet } from './clusterStopwords.ts';

function stemOnce(token: string): string {
  if (token.length > 5 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  if (token.length > 6 && token.endsWith('ing') && !token.endsWith('ring') && !token.endsWith('king')) {
    const stem = token.slice(0, -3);
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      return stem.slice(0, -1);
    }
    return stem;
  }
  return token;
}

function normalizeForms(term: string): string[] {
  const base = term.toLowerCase().replace(/^["'«»„“”]+|["'«»„“”]+$/g, '').trim();
  if (!base) return [];
  const forms = new Set<string>([base]);
  for (const word of base.split(/\s+/)) {
    if (word.length < 3) continue;
    forms.add(word);
    let t = word;
    for (let i = 0; i < 3; i += 1) {
      const next = stemOnce(t);
      if (next === t || next.length < 3) break;
      forms.add(next);
      t = next;
    }
  }
  let t = base;
  for (let i = 0; i < 3; i += 1) {
    const next = stemOnce(t);
    if (next === t || next.length < 3) break;
    forms.add(next);
    t = next;
  }
  return [...forms];
}

/** Terms that must not create or strengthen story clusters (cult/sect vocabulary, locale stopwords). */
export function buildGenericCultClusterTermSet(): Set<string> {
  const set = buildUnionClusterStopwordSet();
  for (const term of ALL_GENERIC_CULT_TERMS) {
    for (const form of normalizeForms(term)) {
      set.add(form);
    }
  }
  return set;
}

export function isGenericCultClusterTerm(term: string, genericTerms: Set<string>): boolean {
  const normalized = term.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  const words = normalized.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) {
    return genericTerms.has(normalized);
  }

  return words.every((word) => {
    for (const form of normalizeForms(word)) {
      if (genericTerms.has(form)) return true;
    }
    return false;
  });
}

/** Unigram anchor usable for clustering edges (excludes generic cult/sect tokens). */
export function isClusterSignalUnigram(term: string, genericTerms: Set<string>, entityAliasCanonicals: Set<string>): boolean {
  if (term.includes(' ') || term.length < 4) return false;
  if (entityAliasCanonicals.has(term)) return false;
  return !isGenericCultClusterTerm(term, genericTerms);
}

/** Bigram anchor usable for clustering (at least one non-generic token). */
export function isClusterSignalBigram(term: string, genericTerms: Set<string>): boolean {
  if (!term.includes(' ') || term.length < 8) return false;
  const words = term.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length < 2) return false;
  return words.some((w) => !isGenericCultClusterTerm(w, genericTerms));
}
