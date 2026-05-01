import type { Env } from '../types';

type DiscoveryFocus = {
  focusSignalTerms: string[];
  googleNewsGenericQueries: string[];
  newsdataQueries: string[];
  priorityWatchlistHosts: string[];
};

type DiscoveryFocusInput = {
  focusSignalTerms?: unknown;
  googleNewsGenericQueries?: unknown;
  newsdataQueries?: unknown;
  priorityWatchlistHosts?: unknown;
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
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

function emptyFocus(): DiscoveryFocus {
  return {
    focusSignalTerms: [],
    googleNewsGenericQueries: [],
    newsdataQueries: [],
    priorityWatchlistHosts: [],
  };
}

export function loadDiscoveryFocus(env: Env): DiscoveryFocus {
  const raw = env.DISCOVERY_FOCUS_JSON?.trim();
  if (!raw) {
    return emptyFocus();
  }

  try {
    const parsed = JSON.parse(raw) as DiscoveryFocusInput;
    return {
      focusSignalTerms: isStringArray(parsed.focusSignalTerms) ? uniqueOrdered(parsed.focusSignalTerms) : [],
      googleNewsGenericQueries: isStringArray(parsed.googleNewsGenericQueries)
        ? uniqueOrdered(parsed.googleNewsGenericQueries)
        : [],
      newsdataQueries: isStringArray(parsed.newsdataQueries) ? uniqueOrdered(parsed.newsdataQueries) : [],
      priorityWatchlistHosts: isStringArray(parsed.priorityWatchlistHosts)
        ? uniqueOrdered(parsed.priorityWatchlistHosts.map((host) => host.toLowerCase()))
        : [],
    };
  } catch {
    return emptyFocus();
  }
}
