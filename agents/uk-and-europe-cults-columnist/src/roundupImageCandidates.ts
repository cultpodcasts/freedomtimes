/**
 * Collect image candidates for roundup sections — prefer inline article photos over og:image crops.
 */

import type { ImageQualityAssessment } from './imageQuality.ts';

export type ImageCandidateSource =
  | 'inline-lead'
  | 'inline-article'
  | 'json-ld'
  | 'twitter:image'
  | 'og:image'
  | 'custom';

export type ImageCandidate = {
  url: string;
  source: ImageCandidateSource;
  storyUrl: string;
  storyHost: string;
  /** Higher = preferred default when editor has not chosen. */
  score: number;
  estimatedWidth?: number;
  altHint?: string;
  /** Filled during collect after HTTP probe (dimensions, tier, reprocess hint). */
  quality?: ImageQualityAssessment;
};

export type UnitImageCandidates = {
  unitId: string;
  unitLabel: string;
  beyondEurope: boolean;
  stories: Array<{ url: string; host: string; title?: string }>;
  candidates: ImageCandidate[];
  /** Top-scored URL after collection; editor may override in selections file. */
  suggestedUrl?: string;
  suggestedAlt?: string;
};

const SKIP_PATH =
  /(?:logo|icon|avatar|sprite|pixel|badge|button|favicon|placeholder|spacer|emoji|gravatar|doubleclick|analytics)/i;
const SKIP_EXT = /\.(?:svg|gif)(?:\?|$)/i;

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

function normalizeUrl(raw: string, baseUrl: string): string | undefined {
  try {
    const trimmed = decodeEntities(raw.trim());
    if (!trimmed || trimmed.startsWith('data:')) return undefined;
    return new URL(trimmed, baseUrl).href;
  } catch {
    return undefined;
  }
}

function estimateWidthFromUrl(url: string): number | undefined {
  const w = url.match(/(?:[?&]w(?:idth)?=)(\d{3,4})/i)?.[1];
  if (w) return Number(w);
  const dims = url.match(/(\d{3,4})x(\d{3,4})/);
  if (dims) return Number(dims[1]);
  const guim = url.match(/\/master\/(\d+)_/);
  if (guim) return Number(guim[1]);
  return undefined;
}

export function scoreForSource(source: ImageCandidateSource, width?: number): number {
  const base: Record<ImageCandidateSource, number> = {
    'inline-lead': 100,
    'inline-article': 85,
    'json-ld': 75,
    'twitter:image': 55,
    'og:image': 40,
    custom: 110,
  };
  let score = base[source];
  if (width) {
    if (width >= 1800) score += 20;
    else if (width >= 1200) score += 15;
    else if (width >= 900) score += 10;
    else if (width >= 600) score += 4;
    else if (width < 200) score -= 30;
    else score -= 10;
  }
  return score;
}

function shouldSkipImage(url: string, widthAttr?: string): boolean {
  if (SKIP_EXT.test(url) || SKIP_PATH.test(url)) return true;
  const w = widthAttr ? Number(widthAttr) : estimateWidthFromUrl(url);
  if (w && w < 120) return true;
  return false;
}

function metaContent(html: string, key: string, attr: 'property' | 'name'): string | undefined {
  const re = new RegExp(
    `<meta[^>]+${attr}=["']${key}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${key}["']`,
    'i',
  );
  const m = html.match(re);
  return m?.[1] ?? m?.[2];
}

function extractJsonLdImages(html: string, pageUrl: string): string[] {
  const urls: string[] = [];
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    const raw = block[1];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const img = rec.image;
        if (typeof img === 'string') urls.push(img);
        else if (Array.isArray(img)) {
          for (const entry of img) {
            if (typeof entry === 'string') urls.push(entry);
            else if (entry && typeof entry === 'object' && typeof (entry as { url?: string }).url === 'string') {
              urls.push((entry as { url: string }).url);
            }
          }
        } else if (img && typeof img === 'object' && typeof (img as { url?: string }).url === 'string') {
          urls.push((img as { url: string }).url);
        }
      }
    } catch {
      // ignore invalid JSON-LD
    }
  }
  return urls.map((u) => normalizeUrl(u, pageUrl)).filter((u): u is string => Boolean(u));
}

function articleHtmlSlice(html: string): string {
  const article =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    html;
  return article;
}

function extractInlineImages(html: string, pageUrl: string): Array<{ url: string; lead: boolean; alt?: string }> {
  const slice = articleHtmlSlice(html);
  const found: Array<{ url: string; lead: boolean; alt?: string }> = [];
  const imgRe = /<img\b[^>]*>/gi;
  let i = 0;
  for (const tag of slice.matchAll(imgRe)) {
    const attrs = tag[0];
    const src =
      attrs.match(/\ssrc=["']([^"']+)["']/i)?.[1] ??
      attrs.match(/\sdata-src=["']([^"']+)["']/i)?.[1];
    if (!src) continue;
    const url = normalizeUrl(src, pageUrl);
    if (!url || shouldSkipImage(url, attrs.match(/\swidth=["'](\d+)["']/i)?.[1])) continue;
    const alt = attrs.match(/\salt=["']([^"']*)["']/i)?.[1];
    found.push({ url, lead: i === 0, alt });
    i++;
  }
  return found;
}

export function extractImageCandidatesFromHtml(
  html: string,
  pageUrl: string,
  storyHost: string,
): ImageCandidate[] {
  const seen = new Set<string>();
  const out: ImageCandidate[] = [];

  const push = (raw: string, source: ImageCandidateSource, altHint?: string) => {
    const url = normalizeUrl(raw, pageUrl);
    if (!url || seen.has(url) || shouldSkipImage(url)) return;
    seen.add(url);
    const estimatedWidth = estimateWidthFromUrl(url);
    out.push({
      url,
      source,
      storyUrl: pageUrl,
      storyHost,
      score: scoreForSource(source, estimatedWidth),
      estimatedWidth,
      altHint,
    });
  };

  for (const { url, lead, alt } of extractInlineImages(html, pageUrl)) {
    push(url, lead ? 'inline-lead' : 'inline-article', alt);
  }

  for (const url of extractJsonLdImages(html, pageUrl)) {
    push(url, 'json-ld');
  }

  const twitter = metaContent(html, 'twitter:image', 'name');
  if (twitter) push(twitter, 'twitter:image');

  const og =
    metaContent(html, 'og:image', 'property') ?? metaContent(html, 'og:image:url', 'property');
  if (og) push(og, 'og:image');

  return out.sort((a, b) => b.score - a.score);
}

export function pickSuggestedCandidate(candidates: ImageCandidate[]): ImageCandidate | undefined {
  return candidates[0];
}
