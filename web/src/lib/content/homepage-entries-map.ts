/**
 * Pure row → entry mapping for the lightweight homepage query
 * (see homepage-entries.ts). Kept free of `emdash` / `cloudflare:workers`
 * imports so it can be unit-tested with tsx.
 */
export type HomepageEntry = {
  id: string;
  slug: string;
  data: Record<string, unknown>;
};

/** Columns the homepage renders (no `content`, no byline/taxonomy hydration). */
export const HOMEPAGE_POST_COLUMNS = [
  'id',
  'slug',
  'status',
  'title',
  'excerpt',
  'subjects',
  'featured_image',
  'created_at',
  'updated_at',
  'published_at',
] as const;

const LOCAL_MEDIA_FILE_PREFIX = '/_emdash/api/media/file/';
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const DATE_COLUMNS: Record<string, string> = {
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  published_at: 'publishedAt',
};
const SYSTEM_PASSTHROUGH: Record<string, string> = { id: 'id', status: 'status' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Mirror of emdash loader `normalizeLocalMediaValue` (1.3.x). */
export function normalizeLocalMediaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLocalMediaValue);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) normalized[key] = normalizeLocalMediaValue(child);
  if (normalized.provider === 'local' && typeof normalized.src === 'string' && normalized.src.length > 0) {
    const src = normalized.src;
    if (src.startsWith(LOCAL_MEDIA_FILE_PREFIX)) {
      const id = src.slice(LOCAL_MEDIA_FILE_PREFIX.length);
      if (!normalized.id && id) normalized.id = id;
    } else if (!src.startsWith('/') && !URL_SCHEME_PATTERN.test(src)) {
      if (!normalized.id) normalized.id = src;
      normalized.src = `${LOCAL_MEDIA_FILE_PREFIX}${src}`;
    }
  }
  return normalized;
}

/** Map one narrow `ec_posts` row to the loader's entry shape (subset of `mapRowToData`). */
export function mapHomepageRow(row: Record<string, unknown>): HomepageEntry {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key in DATE_COLUMNS) {
      data[DATE_COLUMNS[key]] = typeof value === 'string' ? new Date(value) : null;
      continue;
    }
    if (key in SYSTEM_PASSTHROUGH) {
      data[SYSTEM_PASSTHROUGH[key]] = value;
      continue;
    }
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try {
        data[key] = normalizeLocalMediaValue(JSON.parse(value));
      } catch {
        data[key] = value;
      }
      continue;
    }
    data[key] = value;
  }
  const slug = typeof row.slug === 'string' ? row.slug : '';
  const id = slug || (typeof row.id === 'string' ? row.id : '');
  return { id, slug, data };
}
