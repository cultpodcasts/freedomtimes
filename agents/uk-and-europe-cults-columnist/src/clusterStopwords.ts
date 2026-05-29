import { readFileSync } from 'node:fs';
import { loadGroupStopwordsByLanguageFromDiscoveryLangFiles } from './discoveryLangGroupStopwords.ts';

const CLUSTER_STOPWORD_LANG_ALIASES: Record<string, string> = {
  nb: 'no',
  nn: 'no',
};

let clusterStopwordsByLangCache: Map<string, Set<string>> | undefined;

function loadClusterBaseStopwords(): string[] {
  try {
    const configUrl = new URL('../data/cluster-token-stopwords.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(configUrl, 'utf-8')) as { base?: unknown };
    if (!Array.isArray(parsed.base)) {
      return [];
    }
    return parsed.base.map((t) => String(t).toLowerCase());
  } catch {
    return [];
  }
}

export function normalizeClusterStopwordLang(code: string | undefined): string {
  if (!code || code.length < 2) {
    return 'en';
  }
  const base = code.toLowerCase().trim().split('-')[0] ?? 'en';
  return CLUSTER_STOPWORD_LANG_ALIASES[base] ?? base;
}

/** Per-locale cluster stopwords from `data/discovery/lang/<code>.json` → `groupStopwords`. */
export function loadClusterStopwordsByLang(): Map<string, Set<string>> {
  if (clusterStopwordsByLangCache) {
    return clusterStopwordsByLangCache;
  }

  const base = loadClusterBaseStopwords();
  const groupByLang = loadGroupStopwordsByLanguageFromDiscoveryLangFiles();
  const map = new Map<string, Set<string>>();

  for (const [lang, terms] of Object.entries(groupByLang)) {
    const set = new Set(base);
    for (const term of terms) {
      set.add(term.toLowerCase());
    }
    map.set(lang.toLowerCase(), set);
  }

  if (!map.has('en')) {
    map.set('en', new Set(base));
  }

  clusterStopwordsByLangCache = map;
  return map;
}

export function clusterStopwordsForLanguage(lang: string | undefined): Set<string> {
  const map = loadClusterStopwordsByLang();
  const code = normalizeClusterStopwordLang(lang);
  return map.get(code) ?? map.get('en')!;
}

/** Union of every locale list — for language-agnostic cluster edge filtering. */
export function buildUnionClusterStopwordSet(): Set<string> {
  const union = new Set<string>();
  for (const set of loadClusterStopwordsByLang().values()) {
    for (const term of set) {
      union.add(term);
    }
  }
  return union;
}
