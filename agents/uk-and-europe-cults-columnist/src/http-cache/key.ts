export function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

export function buildCacheKey(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}
