export function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

export function buildCacheKey(url: string, suffix?: string): string {
  try {
    const base = new URL(url).toString();
    return suffix ? `${base}#${suffix}` : base;
  } catch {
    return suffix ? `${url}#${suffix}` : url;
  }
}
