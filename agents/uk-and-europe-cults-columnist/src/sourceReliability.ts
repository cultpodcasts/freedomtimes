import { readFileSync } from 'node:fs';
import type { SourceMetadata } from './types.ts';

function loadPublisherDisplayNames(): Record<string, string> {
  const fileUrl = new URL('../data/publisher-display-names.json', import.meta.url);
  const raw = readFileSync(fileUrl, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('data/publisher-display-names.json must be a JSON object');
  }

  const result: Record<string, string> = {};
  for (const [host, name] of Object.entries(parsed)) {
    if (typeof name !== 'string') {
      throw new Error(`data/publisher-display-names.json: publisher name for "${host}" must be a string`);
    }
    result[host.toLowerCase().replace(/^www\./, '')] = name;
  }
  return result;
}

const PUBLISHER_DISPLAY_NAMES = loadPublisherDisplayNames();

function hostFromUrl(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
}

function publisherFromHost(host: string): string {
  return PUBLISHER_DISPLAY_NAMES[host] ?? host;
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
