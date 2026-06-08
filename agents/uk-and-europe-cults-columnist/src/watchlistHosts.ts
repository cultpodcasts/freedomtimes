import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Hosts from watchlist-sites.json — updated centrally, not per script. */
export function loadWatchlistHosts(): Set<string> {
  const raw = JSON.parse(readFileSync(join(agentRoot, 'watchlist-sites.json'), 'utf8')) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error('watchlist-sites.json must be a string array');
  }
  return new Set(
    raw
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase().replace(/^www\./, '')),
  );
}

export function isWatchlistHost(host: string, watchlist: Set<string> = loadWatchlistHosts()): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, '');
  for (const entry of watchlist) {
    if (normalized === entry || normalized.endsWith(`.${entry}`)) {
      return true;
    }
  }
  return false;
}
