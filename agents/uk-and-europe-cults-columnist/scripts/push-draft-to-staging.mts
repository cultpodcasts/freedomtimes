/**
 * Push reports/drafts/{slug}.md to staging EmDash (draft update).
 * Usage: npx tsx scripts/push-draft-to-staging.mts [slug]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(agentRoot, '..', '..');
const webDir = join(repoRoot, 'web');
const draftsDir = join(agentRoot, 'reports', 'drafts');
const slug = process.argv[2] ?? 'weekly-summary-8-june-2026';

const token = process.env.EMDASH_STAGING_PAT;
if (!token) throw new Error('Set EMDASH_STAGING_PAT');

const stagingUrl = 'https://staging.freedomtimes.news';
const mdPath = join(draftsDir, `${slug}.md`);
const uploadsPath = join(draftsDir, `${slug}-images-uploaded.json`);

const md = readFileSync(mdPath, 'utf8');
const titleMatch = md.match(/^#\s+(.+)$/m);
if (!titleMatch) throw new Error('Draft must start with # title');
const title = titleMatch[1]!.trim();
const content = md.replace(/^#\s+.+\n+/, '').trim();

const uploads = JSON.parse(readFileSync(uploadsPath, 'utf8')) as Array<{
  mediaId: string;
  alt: string;
  fileUrl: string;
}>;
const featured = uploads[0];
if (!featured) throw new Error('No uploads for featured_image');

function emdashJson(args: string[]): unknown {
  const up = spawnSync('npx', ['emdash', ...args, '--json'], {
    cwd: webDir,
    encoding: 'utf8',
    shell: false,
  });
  if (up.status !== 0) {
    throw new Error(`emdash ${args.join(' ')} failed: ${up.stderr || up.stdout}`);
  }
  return JSON.parse(up.stdout);
}

const existing = emdashJson([
  'content',
  'get',
  'posts',
  slug,
  '-u',
  stagingUrl,
  '-t',
  token,
]) as {
  _rev?: string;
  draftRevisionId?: string;
  data?: { excerpt?: string; subjects?: string[] };
};

const rev = existing._rev ?? existing.draftRevisionId;
if (!rev) throw new Error('No _rev on staging post — run content get first');

const media = emdashJson([
  'media',
  'get',
  featured.mediaId,
  '-u',
  stagingUrl,
  '-t',
  token,
]) as {
  id: string;
  filename?: string;
  mimeType?: string;
  storageKey?: string;
  alt?: string | null;
};

const excerpt =
  content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('![')) ?? existing.data?.excerpt ?? '';

const payload = {
  title,
  content,
  excerpt: excerpt.slice(0, 300),
  subjects: existing.data?.subjects ?? ['UK', 'Europe', 'Weekly summary'],
  featured_image: {
    id: media.id,
    provider: 'local',
    filename: media.filename,
    mimeType: media.mimeType,
    alt: featured.alt || media.alt || title,
    meta: media.storageKey ? { storageKey: media.storageKey } : {},
  },
};

const tmpDir = join(draftsDir, '_tmp');
mkdirSync(tmpDir, { recursive: true });
const payloadPath = join(tmpDir, `${slug}.post.json`);
writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

const up = spawnSync(
  'npx',
  [
    'emdash',
    'content',
    'update',
    'posts',
    slug,
    '--rev',
    rev,
    '--file',
    payloadPath,
    '--draft',
    '-u',
    stagingUrl,
    '-t',
    token,
    '--json',
  ],
  { cwd: webDir, encoding: 'utf8', shell: false },
);
if (up.status !== 0) {
  throw new Error(`content update failed: ${up.stderr || up.stdout}`);
}

const result = JSON.parse(up.stdout);
console.log('updated staging draft', slug, 'version', result.version ?? result.item?.version);
console.log('review:', `${stagingUrl}/posts/${slug}`);
