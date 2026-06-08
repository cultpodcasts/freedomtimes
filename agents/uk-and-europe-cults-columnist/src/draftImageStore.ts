import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RoundupImageCandidatesFile } from './collectRoundupImageCandidates.ts';

export const CUSTOM_IMAGES_DIR = '_custom';

export function candidatesPath(draftsDir: string, slug: string): string {
  return join(draftsDir, `${slug}-image-candidates.json`);
}

export function selectionsPath(draftsDir: string, slug: string): string {
  return join(draftsDir, `${slug}-image-selections.json`);
}

export function customImagesDir(draftsDir: string, slug: string): string {
  return join(draftsDir, CUSTOM_IMAGES_DIR, slug);
}

export function loadCandidatesFile(draftsDir: string, slug: string): RoundupImageCandidatesFile | null {
  const p = candidatesPath(draftsDir, slug);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as RoundupImageCandidatesFile;
}

export function saveCandidatesFile(draftsDir: string, data: RoundupImageCandidatesFile): void {
  mkdirSync(draftsDir, { recursive: true });
  writeFileSync(candidatesPath(draftsDir, data.slug), JSON.stringify(data, null, 2), 'utf8');
}

/** Map served URL → on-disk path for editor-pasted images. */
export function localCustomImagePathFromUrl(url: string, draftsDir: string): string | null {
  const m = url.match(/\/api\/draft-images\/custom\/([^/]+)\/([^/?#]+)/i);
  if (!m) return null;
  const [, slug, filename] = m;
  if (!slug || !filename) return null;
  const p = join(draftsDir, CUSTOM_IMAGES_DIR, slug, filename);
  return existsSync(p) ? p : null;
}

export function customImagePublicUrl(baseUrl: string, slug: string, filename: string): string {
  const origin = baseUrl.replace(/\/$/, '');
  return `${origin}/api/draft-images/custom/${encodeURIComponent(slug)}/${encodeURIComponent(filename)}`;
}

export function mimeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}
