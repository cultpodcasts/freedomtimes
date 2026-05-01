import type { SourceMetadata } from './types.js';

function hostFromUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
}

function publisherFromHost(host: string): string {
  const mapping: Record<string, string> = {
    'culteducation.com': 'Cult Education Institute',
    'cultnews.net': 'CultNews',
    'cultnews101.com': 'CultNews101',
    'thetimes.co.uk': 'The Times',
    'telegraph.co.uk': 'The Telegraph',
    'dailyrecord.co.uk': 'Daily Record',
    'dailymail.co.uk': 'Daily Mail',
    'thesun.co.uk': 'The Sun',
    'mirror.co.uk': 'Mirror',
    'bbc.com': 'BBC',
    'theguardian.com': 'The Guardian',
    'reuters.com': 'Reuters',
    'apnews.com': 'Associated Press',
    'ft.com': 'Financial Times',
    'politico.eu': 'POLITICO Europe',
    'euobserver.com': 'EUobserver',
    'dw.com': 'Deutsche Welle',
    'lemonde.fr': 'Le Monde',
    'elpais.com': 'El Pais',
  };

  return mapping[host] ?? host;
}

export function evaluateSourceReliability(
  url: string,
  allowedHosts: Set<string>,
  publishedAt?: string,
): SourceMetadata {
  const host = hostFromUrl(url);
  const reasons: string[] = [];
  let score = 0;

  if (url.startsWith('https://')) {
    score += 30;
    reasons.push('HTTPS source URL');
  } else {
    reasons.push('Non-HTTPS source URL');
  }

  if (allowedHosts.has(host)) {
    score += 50;
    reasons.push('Source host is on reliability allowlist');
  } else {
    reasons.push('Source host is not on reliability allowlist');
  }

  if (publishedAt) {
    score += 20;
    reasons.push('Article includes a publication date');
  } else {
    reasons.push('No publication date detected');
  }

  return {
    url,
    publisher: publisherFromHost(host),
    host,
    retrievedAt: new Date().toISOString(),
    publishedAt,
    reliabilityScore: Math.max(0, Math.min(100, score)),
    reliabilityReasons: reasons,
  };
}
