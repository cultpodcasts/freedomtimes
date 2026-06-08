/**
 * Probe remote images and assess suitability for Freedom Times roundup usage.
 *
 * Display targets (see web/DESIGN_GUIDE.md, homepage.astro):
 * - Article inline / hero in post: ~900px column width
 * - Homepage lead crop: 1200×675 via Cloudflare Images
 */

import type { ImageCandidateSource } from './roundupImageCandidates.ts';

export const IMAGE_USAGE_TARGETS = {
  articleWidth: 900,
  featuredLongEdge: 1200,
  featuredShortEdge: 675,
  retinaLongEdge: 1800,
  minAcceptableLongEdge: 600,
  minPoorLongEdge: 400,
  /** Below this, likely a thumbnail or over-compressed asset */
  minLikelyPhotoBytes: 20_000,
  /** Above this, worth recompressing before CMS upload */
  recompressAboveBytes: 2_500_000,
} as const;

export type ImageQualityTier = 'excellent' | 'good' | 'marginal' | 'poor' | 'unknown';

export type ImageQualityRecommendation =
  | 'use-as-is'
  | 'acceptable'
  | 'reprocess'
  | 'low-res'
  | 'unsuitable';

export type ImageProbeResult = {
  width?: number;
  height?: number;
  bytes?: number;
  mimeType?: string;
};

export type ImageQualityAssessment = {
  width?: number;
  height?: number;
  bytes?: number;
  mimeType?: string;
  longEdge?: number;
  shortEdge?: number;
  megapixels?: number;
  aspectRatio?: number;
  tier: ImageQualityTier;
  recommendation: ImageQualityRecommendation;
  /** e.g. "1920×1080 · 245 KB · JPEG" */
  label: string;
  warnings: string[];
  probed: boolean;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMime(mime?: string): string {
  if (!mime) return '';
  const map: Record<string, string> = {
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/gif': 'GIF',
    'image/avif': 'AVIF',
  };
  return map[mime.toLowerCase()] ?? mime.replace('image/', '').toUpperCase();
}

function isOgCropAspect(ratio: number): boolean {
  // Common social cards: 1.91:1 (1200×630), 2:1, 16:9 is fine for hero
  return ratio >= 1.75 && ratio <= 2.05;
}

export function parseImageDimensions(
  buffer: Buffer,
  mimeHint?: string,
): { width?: number; height?: number } {
  if (buffer.length < 24) return {};

  // PNG
  if (
    buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  // WebP — RIFF....WEBP
  if (
    buffer.length >= 30
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const w = 1 + (buffer[24]! | (buffer[25]! << 8) | (buffer[26]! << 16));
      const h = 1 + (buffer[27]! | (buffer[28]! << 8) | (buffer[29]! << 16));
      return { width: w, height: h };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer[21]! | (buffer[22]! << 8) | (buffer[23]! << 16) | (buffer[24]! << 24);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }

  // JPEG — scan for SOF markers
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i < buffer.length - 8) {
      if (buffer[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buffer[i + 1];
      if (marker === undefined) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buffer.readUInt16BE(i + 5),
          width: buffer.readUInt16BE(i + 7),
        };
      }
      const len = buffer.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }

  if (mimeHint?.includes('png')) {
    return parseImageDimensions(buffer);
  }

  return {};
}

const PROBE_HEADERS = {
  'User-Agent': 'FreedomTimesBot/1.0 (+https://freedomtimes.news)',
};

export async function fetchImageProbe(url: string): Promise<ImageProbeResult> {
  let bytes: number | undefined;
  let mimeType: string | undefined;

  try {
    const head = await fetch(url, { method: 'HEAD', headers: PROBE_HEADERS, redirect: 'follow' });
    if (head.ok) {
      const cl = head.headers.get('content-length');
      if (cl) bytes = Number(cl);
      mimeType = head.headers.get('content-type')?.split(';')[0]?.trim();
    }
  } catch {
    // HEAD often blocked — fall through to range GET
  }

  const res = await fetch(url, {
    headers: { ...PROBE_HEADERS, Range: 'bytes=0-65535' },
    redirect: 'follow',
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`HTTP ${res.status}`);
  }

  if (!bytes) {
    const cl = res.headers.get('content-length');
    const cr = res.headers.get('content-range');
    if (cr) {
      const total = cr.match(/\/(\d+)$/)?.[1];
      if (total) bytes = Number(total);
    } else if (cl) {
      bytes = Number(cl);
    }
  }
  if (!mimeType) {
    mimeType = res.headers.get('content-type')?.split(';')[0]?.trim();
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!bytes) bytes = buf.length;

  const dims = parseImageDimensions(buf, mimeType);
  return { ...dims, bytes, mimeType };
}

export function assessImageQuality(
  probe: ImageProbeResult,
  context?: { source?: ImageCandidateSource; estimatedWidth?: number },
): ImageQualityAssessment {
  const width = probe.width ?? context?.estimatedWidth;
  const height = probe.height;
  const longEdge = width && height ? Math.max(width, height) : width;
  const shortEdge = width && height ? Math.min(width, height) : undefined;
  const megapixels = width && height ? Math.round((width * height) / 10_000) / 100 : undefined;
  const aspectRatio = width && height ? Math.round((width / height) * 100) / 100 : undefined;
  const probed = Boolean(probe.width && probe.height);
  const warnings: string[] = [];

  const T = IMAGE_USAGE_TARGETS;

  if (context?.source === 'og:image') {
    warnings.push('OG/social image — often a crop, not the article photo');
  }
  if (aspectRatio && isOgCropAspect(aspectRatio)) {
    warnings.push('≈1.91:1 aspect — social card crop; may letterbox as in-article hero');
  }
  if (probe.bytes && probe.bytes < T.minLikelyPhotoBytes && longEdge && longEdge < 800) {
    warnings.push('Small file — likely thumbnail or heavy compression');
  }
  if (probe.bytes && probe.bytes > T.recompressAboveBytes) {
    warnings.push(`Large source (${formatBytes(probe.bytes)}) — recompress before upload`);
  }
  if (longEdge && longEdge < T.articleWidth) {
    warnings.push(`Below ${T.articleWidth}px article width — may look soft at full column`);
  }
  if (longEdge && longEdge < T.minPoorLongEdge) {
    warnings.push('Very low resolution — prefer another candidate');
  }
  if (!probed && !width) {
    warnings.push('Could not read dimensions — verify visually');
  }

  let tier: ImageQualityTier = 'unknown';
  let recommendation: ImageQualityRecommendation = 'acceptable';

  if (longEdge) {
    if (longEdge >= T.retinaLongEdge) tier = 'excellent';
    else if (longEdge >= T.featuredLongEdge) tier = 'excellent';
    else if (longEdge >= T.articleWidth) tier = 'good';
    else if (longEdge >= T.minAcceptableLongEdge) tier = 'marginal';
    else tier = 'poor';
  } else if (context?.estimatedWidth) {
    tier = context.estimatedWidth >= T.articleWidth ? 'good' : 'marginal';
  }

  if (tier === 'poor' || (longEdge && longEdge < T.minPoorLongEdge)) {
    recommendation = 'unsuitable';
  } else if (longEdge && longEdge < T.minAcceptableLongEdge) {
    recommendation = 'low-res';
  } else if (probe.bytes && probe.bytes > T.recompressAboveBytes) {
    recommendation = 'reprocess';
  } else if (tier === 'excellent' || tier === 'good') {
    recommendation = longEdge && longEdge >= T.featuredLongEdge ? 'use-as-is' : 'acceptable';
  } else {
    recommendation = 'acceptable';
  }

  const dimPart =
    width && height ? `${width}×${height}` : width ? `~${width}px wide` : 'size unknown';
  const parts = [dimPart];
  if (probe.bytes) parts.push(formatBytes(probe.bytes));
  const mimeLabel = formatMime(probe.mimeType);
  if (mimeLabel) parts.push(mimeLabel);

  return {
    width: probe.width,
    height: probe.height,
    bytes: probe.bytes,
    mimeType: probe.mimeType,
    longEdge,
    shortEdge,
    megapixels,
    aspectRatio,
    tier,
    recommendation,
    label: parts.join(' · '),
    warnings,
    probed,
  };
}

export async function probeImageQuality(
  url: string,
  context?: { source?: ImageCandidateSource; estimatedWidth?: number },
): Promise<ImageQualityAssessment> {
  try {
    const probe = await fetchImageProbe(url);
    return assessImageQuality(probe, context);
  } catch {
    return assessImageQuality({}, context);
  }
}

export function assessImageFromBuffer(buffer: Buffer, mimeType?: string): ImageQualityAssessment {
  const dims = parseImageDimensions(buffer, mimeType);
  return assessImageQuality(
    { width: dims.width, height: dims.height, bytes: buffer.length, mimeType },
    undefined,
  );
}
