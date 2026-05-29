export type ArchiveMirrorLink = {
  label: string;
  href: string;
};

const ARCHIVE_MIRROR_HOSTS = new Set([
  'archive.ph',
  'archive.is',
  'archive.today',
  'archive.li',
  'archive.vn',
  'web.archive.org',
]);

export function isArchiveMirrorHost(host: string): boolean {
  return ARCHIVE_MIRROR_HOSTS.has(host.toLowerCase().replace(/^www\./, ''));
}

/** Extract the publisher URL embedded in an archive.ph / archive.is / Wayback URL. */
export function unwrapArchiveMirrorUrl(mirrorUrl: string): string | undefined {
  try {
    const parsed = new URL(mirrorUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'archive.ph' || host === 'archive.is' || host === 'archive.today' || host === 'archive.li') {
      const path = decodeURIComponent(parsed.pathname);
      const embedded = path.match(/\/(https?:\/\/.+)$/i);
      if (embedded?.[1]) {
        return embedded[1];
      }
      return undefined;
    }

    if (host === 'web.archive.org') {
      const embedded = parsed.pathname.match(/^\/web\/\d+\/(https?:\/\/.+)$/i);
      if (embedded?.[1]) {
        return embedded[1];
      }
    }
  } catch {
    // Ignore malformed URLs.
  }

  return undefined;
}

/** Prefer the publisher URL when the stored link is an archive mirror. */
export function getCanonicalArticleUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (isArchiveMirrorHost(host)) {
      return unwrapArchiveMirrorUrl(url) ?? url;
    }
  } catch {
    // Fall through to raw URL.
  }

  return url;
}

function snapshotLinkLabel(snapshotUrl: string): string {
  try {
    const parsed = new URL(snapshotUrl);
    const host = parsed.hostname.replace(/^www\./, '');
    const segment = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (segment.length <= 12 && !segment.startsWith('http')) {
      return `${host}/${segment}`;
    }
    return `${host} (saved copy)`;
  } catch {
    return 'Saved snapshot';
  }
}

/** Archive services that may host a readable copy of a paywalled article. */
export function buildArchiveMirrorLinks(
  canonicalUrl: string,
  options?: { knownSnapshotUrls?: string[] },
): ArchiveMirrorLink[] {
  const links: ArchiveMirrorLink[] = [];
  const seen = new Set<string>();

  for (const snapshotUrl of options?.knownSnapshotUrls ?? []) {
    const trimmed = snapshotUrl.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    links.push({ label: snapshotLinkLabel(trimmed), href: trimmed });
  }

  const candidates: ArchiveMirrorLink[] = [
    { label: 'archive.ph', href: `https://archive.ph/newest/${canonicalUrl}` },
    { label: 'archive.is', href: `https://archive.is/newest/${canonicalUrl}` },
    { label: 'Wayback Machine', href: `https://web.archive.org/web/*/${canonicalUrl}` },
  ];

  for (const candidate of candidates) {
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    links.push(candidate);
  }

  return links;
}

/** Heuristic: direct fetch returned paywall chrome rather than article body. */
export function looksLikePartialPaywall(text: string): boolean {
  const sample = text.slice(0, 1200).toLowerCase();
  if (sample.length < 200) return true;
  const paywallMarkers =
    /\babonn[eé]s?\b/.test(sample) ||
    /\bsubscribers?\s+only\b/.test(sample) ||
    /\bsubscribe\s+to\s+(read|continue|unlock)\b/.test(sample) ||
    /\bregister\s+to\s+continue\b/.test(sample);
  const thinBody = text.length < 1800;
  return paywallMarkers && thinBody;
}
