import { readFileSync } from 'node:fs';

type DiscoveryConfig = {
  googleNewsCountryTerms?: unknown;
  googleNewsGenericQueries?: unknown;
  googleNewsQueryDefinitions?: unknown;
  newsdataCountryCodes?: unknown;
  newsdataLanguages?: unknown;
  newsdataQueries?: unknown;
  regionTerms?: unknown;
  regionalHostSuffixes?: unknown;
  focusSignalTerms?: unknown;
};

type GoogleNewsQueryDefinitions = {
  groups?: unknown;
  templates?: unknown;
  rawQueries?: unknown;
};

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`discovery-config.json field '${field}' must be a string array`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`discovery-config.json field '${field}' must be a string`);
  }
  return value;
}

function expectStringRecordOfArrays(value: unknown, field: string): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`discovery-config.json field '${field}' must be an object of string arrays`);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, string[]> = {};

  for (const [key, nested] of entries) {
    output[key] = expectStringArray(nested, `${field}.${key}`);
  }

  return output;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function formatGroupExpression(values: string[]): string {
  return `(${values.join(' OR ')})`;
}

function buildGoogleNewsQueriesFromDefinitions(
  definitionsValue: unknown,
  fallbackQueries: string[] | undefined,
): string[] {
  if (definitionsValue === undefined) {
    return fallbackQueries ?? [];
  }

  if (!definitionsValue || typeof definitionsValue !== 'object' || Array.isArray(definitionsValue)) {
    throw new Error("discovery-config.json field 'googleNewsQueryDefinitions' must be an object");
  }

  const definitions = definitionsValue as GoogleNewsQueryDefinitions;
  const groups = expectStringRecordOfArrays(definitions.groups, 'googleNewsQueryDefinitions.groups');
  const templates = expectStringArray(definitions.templates, 'googleNewsQueryDefinitions.templates');
  const rawQueries =
    definitions.rawQueries === undefined
      ? []
      : expectStringArray(definitions.rawQueries, 'googleNewsQueryDefinitions.rawQueries');

  const expandedTemplates = templates.map((template) => {
    const query = template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g, (_match, groupName: string) => {
      const groupValues = groups[groupName];
      if (!groupValues) {
        throw new Error(
          `discovery-config.json template references unknown group '${groupName}' in googleNewsQueryDefinitions.templates`,
        );
      }
      return formatGroupExpression(groupValues);
    });

    return normalizeWhitespace(query);
  });

  const unique = new Set<string>();
  const ordered: string[] = [];

  for (const query of [...expandedTemplates, ...rawQueries]) {
    const normalized = normalizeWhitespace(query);
    if (!normalized || unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    ordered.push(normalized);
  }

  return ordered;
}

function loadWatchlistSites(): string[] {
  const configUrl = new URL('../watchlist-sites.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  return expectStringArray(parsed, 'watchlist-sites');
}

/**
 * Merge `googleNewsQueryDefinitions.groups` (optional, legacy) with each JSON file in `groupFiles`
 * (paths relative to the package root, same directory as `discovery-config.json`).
 */
function loadMergedGoogleNewsQueryGroups(
  parsed: DiscoveryConfig,
  packageRootUrl: URL,
): Record<string, string[]> {
  const definitions = parsed.googleNewsQueryDefinitions;
  if (!definitions || typeof definitions !== 'object' || Array.isArray(definitions)) {
    return {};
  }

  const def = definitions as GoogleNewsQueryDefinitions & {
    groupFiles?: unknown;
    groups?: unknown;
  };

  const merged: Record<string, string[]> = {};

  if (def.groups && typeof def.groups === 'object' && !Array.isArray(def.groups)) {
    const inline = expectStringRecordOfArrays(def.groups, 'googleNewsQueryDefinitions.groups');
    for (const [k, v] of Object.entries(inline)) {
      merged[k] = v;
    }
  }

  if (!Array.isArray(def.groupFiles)) {
    return merged;
  }

  for (const rel of def.groupFiles) {
    if (typeof rel !== 'string' || !rel.trim()) {
      continue;
    }
    const pathPart = rel.trim().replace(/^\/+/, '');
    const fileUrl = new URL(pathPart, packageRootUrl);
    let raw: string;
    try {
      raw = readFileSync(fileUrl, 'utf-8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read discovery group file '${rel}': ${message}`);
    }
    const fileParsed = JSON.parse(raw) as { groups?: unknown };
    if (!fileParsed.groups || typeof fileParsed.groups !== 'object' || Array.isArray(fileParsed.groups)) {
      throw new Error(`Discovery group file '${rel}' must contain a "groups" object`);
    }
    const chunk = expectStringRecordOfArrays(fileParsed.groups, `${pathPart}.groups`);
    for (const [k, v] of Object.entries(chunk)) {
      if (Object.prototype.hasOwnProperty.call(merged, k)) {
        throw new Error(
          `Duplicate Google News query group '${k}' while merging '${rel}' into discovery config`,
        );
      }
      merged[k] = v;
    }
  }

  return merged;
}

function loadDiscoveryConfig(): {
  googleNewsCountryTerms: string[];
  googleNewsGenericQueries: string[];
  googleNewsQueryGroups: Record<string, string[]>;
  newsdataCountryCodes: string;
  newsdataLanguages: string;
  newsdataQueries: string[];
  regionTerms: string[];
  regionalHostSuffixes: string[];
  focusSignalTerms: string[];
} {
  const packageRootUrl = new URL('../', import.meta.url);
  const configUrl = new URL('../discovery-config.json', import.meta.url);
  const raw = readFileSync(configUrl, 'utf-8');
  const parsed = JSON.parse(raw) as DiscoveryConfig;
  const mergedQueryGroups = loadMergedGoogleNewsQueryGroups(parsed, packageRootUrl);
  const fallbackGoogleQueries = parsed.googleNewsGenericQueries
    ? expectStringArray(parsed.googleNewsGenericQueries, 'googleNewsGenericQueries')
    : undefined;

  const definitions = parsed.googleNewsQueryDefinitions;
  const syntheticDefinitions =
    definitions && typeof definitions === 'object' && !Array.isArray(definitions)
      ? { ...(definitions as Record<string, unknown>), groups: mergedQueryGroups }
      : { groups: mergedQueryGroups };

  return {
    googleNewsCountryTerms: expectStringArray(parsed.googleNewsCountryTerms, 'googleNewsCountryTerms'),
    googleNewsGenericQueries: buildGoogleNewsQueriesFromDefinitions(
      syntheticDefinitions,
      fallbackGoogleQueries,
    ),
    googleNewsQueryGroups: mergedQueryGroups,
    newsdataCountryCodes: expectString(parsed.newsdataCountryCodes, 'newsdataCountryCodes'),
    newsdataLanguages: expectString(parsed.newsdataLanguages, 'newsdataLanguages'),
    newsdataQueries: expectStringArray(parsed.newsdataQueries, 'newsdataQueries'),
    regionTerms: expectStringArray(parsed.regionTerms, 'regionTerms'),
    regionalHostSuffixes: parsed.regionalHostSuffixes
      ? expectStringArray(parsed.regionalHostSuffixes, 'regionalHostSuffixes')
      : [],
    focusSignalTerms: parsed.focusSignalTerms
      ? expectStringArray(parsed.focusSignalTerms, 'focusSignalTerms')
      : [],
  };
}

function uniqueOrdered(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function mergeCsv(base: string, extra: string): string {
  const baseValues = base
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const extraValues = extra
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return uniqueOrdered([...baseValues, ...extraValues]).join(',');
}

type DiscoveryFocusInput = {
  googleNewsCountryTerms?: unknown;
  googleNewsGenericQueries?: unknown;
  newsdataCountryCodes?: unknown;
  newsdataLanguages?: unknown;
  newsdataQueries?: unknown;
  regionTerms?: unknown;
  priorityWatchlistHosts?: unknown;
  googleNewsWatchlistSites?: unknown;
  regionalHostSuffixes?: unknown;
  focusSignalTerms?: unknown;
};

function loadDiscoveryFocusInput(): DiscoveryFocusInput | null {
  const inline = process.env.DISCOVERY_FOCUS_JSON?.trim();
  const filePath = process.env.DISCOVERY_FOCUS_FILE?.trim();

  if (inline) {
    return JSON.parse(inline) as DiscoveryFocusInput;
  }

  if (filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DiscoveryFocusInput;
  }

  return null;
}

const DISCOVERY_CONFIG = loadDiscoveryConfig();
const WATCHLIST_SITES = loadWatchlistSites();
const DISCOVERY_FOCUS_INPUT = loadDiscoveryFocusInput();

const MERGED_DISCOVERY_CONFIG = (() => {
  if (!DISCOVERY_FOCUS_INPUT) {
    return DISCOVERY_CONFIG;
  }

  return {
    googleNewsCountryTerms: uniqueOrdered([
      ...DISCOVERY_CONFIG.googleNewsCountryTerms,
      ...(DISCOVERY_FOCUS_INPUT.googleNewsCountryTerms
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.googleNewsCountryTerms, 'focus.googleNewsCountryTerms')
        : []),
    ]),
    googleNewsGenericQueries: uniqueOrdered([
      ...DISCOVERY_CONFIG.googleNewsGenericQueries,
      ...(DISCOVERY_FOCUS_INPUT.googleNewsGenericQueries
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.googleNewsGenericQueries, 'focus.googleNewsGenericQueries')
        : []),
    ]),
    googleNewsQueryGroups: DISCOVERY_CONFIG.googleNewsQueryGroups,
    newsdataCountryCodes: DISCOVERY_FOCUS_INPUT.newsdataCountryCodes
      ? mergeCsv(
          DISCOVERY_CONFIG.newsdataCountryCodes,
          expectString(DISCOVERY_FOCUS_INPUT.newsdataCountryCodes, 'focus.newsdataCountryCodes'),
        )
      : DISCOVERY_CONFIG.newsdataCountryCodes,
    newsdataLanguages: DISCOVERY_FOCUS_INPUT.newsdataLanguages
      ? mergeCsv(
          DISCOVERY_CONFIG.newsdataLanguages,
          expectString(DISCOVERY_FOCUS_INPUT.newsdataLanguages, 'focus.newsdataLanguages'),
        )
      : DISCOVERY_CONFIG.newsdataLanguages,
    newsdataQueries: uniqueOrdered([
      ...DISCOVERY_CONFIG.newsdataQueries,
      ...(DISCOVERY_FOCUS_INPUT.newsdataQueries
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.newsdataQueries, 'focus.newsdataQueries')
        : []),
    ]),
    regionTerms: uniqueOrdered([
      ...DISCOVERY_CONFIG.regionTerms,
      ...(DISCOVERY_FOCUS_INPUT.regionTerms
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.regionTerms, 'focus.regionTerms')
        : []),
    ]),
    regionalHostSuffixes: uniqueOrdered([
      ...DISCOVERY_CONFIG.regionalHostSuffixes,
      ...(DISCOVERY_FOCUS_INPUT.regionalHostSuffixes
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.regionalHostSuffixes, 'focus.regionalHostSuffixes')
        : []),
    ]),
    focusSignalTerms: uniqueOrdered([
      ...DISCOVERY_CONFIG.focusSignalTerms,
      ...(DISCOVERY_FOCUS_INPUT.focusSignalTerms
        ? expectStringArray(DISCOVERY_FOCUS_INPUT.focusSignalTerms, 'focus.focusSignalTerms')
        : []),
    ]),
  };
})();

const MERGED_WATCHLIST_SITES = (() => {
  if (!DISCOVERY_FOCUS_INPUT) {
    return WATCHLIST_SITES;
  }

  const extraPriority = DISCOVERY_FOCUS_INPUT.priorityWatchlistHosts
    ? expectStringArray(DISCOVERY_FOCUS_INPUT.priorityWatchlistHosts, 'focus.priorityWatchlistHosts')
    : [];
  const extraGoogle = DISCOVERY_FOCUS_INPUT.googleNewsWatchlistSites
    ? expectStringArray(DISCOVERY_FOCUS_INPUT.googleNewsWatchlistSites, 'focus.googleNewsWatchlistSites')
    : [];

  return uniqueOrdered([...WATCHLIST_SITES, ...extraPriority, ...extraGoogle]);
})();

export const PRIORITY_WATCHLIST_HOSTS = MERGED_WATCHLIST_SITES;
export const GOOGLE_NEWS_WATCHLIST_SITES = MERGED_WATCHLIST_SITES;
export const GOOGLE_NEWS_COUNTRY_TERMS = MERGED_DISCOVERY_CONFIG.googleNewsCountryTerms;
export const GOOGLE_NEWS_GENERIC_QUERIES = MERGED_DISCOVERY_CONFIG.googleNewsGenericQueries;
/** Named OR-groups from `discovery-config.json` (`groupFiles` + optional inline `groups`); not expanded templates. */
export const GOOGLE_NEWS_QUERY_GROUPS = MERGED_DISCOVERY_CONFIG.googleNewsQueryGroups;
export const NEWSDATA_COUNTRY_CODES = MERGED_DISCOVERY_CONFIG.newsdataCountryCodes;
export const NEWSDATA_LANGUAGES = MERGED_DISCOVERY_CONFIG.newsdataLanguages;
export const NEWSDATA_QUERIES = MERGED_DISCOVERY_CONFIG.newsdataQueries;
export const REGION_TERMS = MERGED_DISCOVERY_CONFIG.regionTerms;
export const REGIONAL_HOST_SUFFIXES = MERGED_DISCOVERY_CONFIG.regionalHostSuffixes;
export const FOCUS_SIGNAL_TERMS = MERGED_DISCOVERY_CONFIG.focusSignalTerms;
