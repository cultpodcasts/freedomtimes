/**
 * Fetch og:image per unit, upload to staging EmDash, write reports/drafts/weekly-summary-images.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.join(__dirname, '..');
const repoRoot = path.join(agentRoot, '..', '..');
const webDir = path.join(repoRoot, 'web');
const tmpDir = path.join(agentRoot, 'reports', 'drafts', '_images');
mkdirSync(tmpDir, { recursive: true });

function ogFromHtml(html) {
  const m =
    html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  return m?.[1]?.replace(/&#038;/g, '&');
}

const plan = JSON.parse(readFileSync(path.join(agentRoot, 'reports/article-plan.json'), 'utf8'));
const article = plan.articles[0];
const byUnit = new Map();
for (const s of article.stories) {
  byUnit.set(s.unitId, [...(byUnit.get(s.unitId) ?? []), s]);
}

const tierA = [
  'theguardian.com',
  'independent.co.uk',
  'dn.se',
  'aftonbladet.se',
  'aftenposten.no',
  'expressen.se',
  'lefigaro.fr',
  'hollywoodreporter.com',
  'nottinghampost.com',
  'watson.ch',
  'charentelibre.fr',
  'vaticannews.va',
  'kvartal.se',
  'themercury.com',
  '1350kman.com',
];

const token = process.env.EMDASH_STAGING_PAT;
if (!token) throw new Error('Set EMDASH_STAGING_PAT');

const uploads = [];

for (const uid of article.unitIds) {
  const stories = byUnit.get(uid);
  const pick = stories.find((s) => tierA.some((h) => s.host.includes(h))) ?? stories[0];
  let og;
  try {
    const r = await fetch(pick.url, {
      headers: { 'User-Agent': 'FreedomTimesBot/1.0 (+https://freedomtimes.news)' },
      redirect: 'follow',
    });
    og = ogFromHtml(await r.text());
  } catch (e) {
    console.warn('fetch failed', pick.unitLabel, e.message);
    continue;
  }
  if (!og) {
    console.warn('no og:image', pick.unitLabel);
    continue;
  }

  const ext = og.includes('.png') ? 'png' : og.includes('.webp') ? 'webp' : 'jpg';
  const safe = uid.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const localPath = path.join(tmpDir, `${safe}.${ext}`);
  const imgRes = await fetch(og, {
    headers: { 'User-Agent': 'FreedomTimesBot/1.0' },
    redirect: 'follow',
  });
  if (!imgRes.ok) {
    console.warn('image download failed', og, imgRes.status);
    continue;
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  writeFileSync(localPath, buf);

  const alt = pick.unitLabel.replace(/\s+/g, ' ').trim().slice(0, 120);
  const safeAlt = alt.replace(/[|]/g, '-').slice(0, 120);
  const up = spawnSync(
    'npx',
    [
      'emdash',
      'media',
      'upload',
      localPath,
      '--alt',
      safeAlt,
      '-u',
      'https://staging.freedomtimes.news',
      '-t',
      token,
      '--json',
    ],
    { cwd: webDir, encoding: 'utf8', shell: false },
  );
  if (up.status !== 0) {
    console.warn('upload failed', pick.unitLabel, up.stderr || up.stdout);
    continue;
  }
  const media = JSON.parse(up.stdout);
  const fileUrl = `https://staging.freedomtimes.news/_emdash/api/media/file/${media.id}`;
  uploads.push({
    unitId: uid,
    label: pick.unitLabel,
    alt,
    ogImage: og,
    mediaId: media.id,
    fileUrl,
    localPath,
  });
  console.log('uploaded', pick.unitLabel.slice(0, 50), media.id);
  await new Promise((r) => setTimeout(r, 500));
}

writeFileSync(
  path.join(agentRoot, 'reports/drafts/weekly-summary-images.json'),
  JSON.stringify(uploads, null, 2),
);
console.log('wrote', uploads.length, 'images');
