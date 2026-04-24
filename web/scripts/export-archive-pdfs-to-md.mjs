import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import { createClient } from '@libsql/client';

const BASE_URL = 'https://staging.freedomtimes.news';
const OUT_DIR = path.resolve('.generated', 'archive-markdown');

function readEnvVar(name, envText) {
  const line = envText.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : null;
}

function parseJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sanitizeText(text) {
  return String(text)
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchPdfBuffer(url, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

const envText = await readFile(path.resolve('..', '.env.dev'), 'utf8');
const cookie = await readFile(path.resolve('..', '.cookie'), 'utf8').then((v) => v.trim()).catch(() => null);
const url = readEnvVar('TURSO_DATABASE_URL', envText);
const authToken = readEnvVar('TURSO_AUTH_TOKEN', envText);

if (!url || !authToken) {
  throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in .env.dev');
}

const db = createClient({ url, authToken });
await mkdir(OUT_DIR, { recursive: true });

const mediaRows = (await db.execute('SELECT id, storage_key FROM media')).rows;
const storageById = new Map(mediaRows.map((row) => [String(row.id), String(row.storage_key || '')]));

const archives = (
  await db.execute(`
    SELECT id, slug, title, date, pdf_file
    FROM ec_archives
    WHERE deleted_at IS NULL
    ORDER BY date ASC, slug ASC
  `)
).rows;

const manifest = [];

for (const row of archives) {
  const slug = String(row.slug);
  const title = String(row.title || slug);
  const date = String(row.date || '');
  const pdfField = parseJson(row.pdf_file);
  const pdfId = pdfField && typeof pdfField.id === 'string' && pdfField.id.length > 0 ? pdfField.id : null;

  let pdfPath = pdfField && typeof pdfField.src === 'string' && pdfField.src.length > 0 ? pdfField.src : null;
  if (!pdfPath && pdfId) {
    const storageKey = storageById.get(pdfId);
    if (storageKey) {
      pdfPath = `/_emdash/api/media/file/${storageKey}`;
    }
  }

  if (!pdfPath) {
    console.log(`skip ${slug}: no PDF path`);
    continue;
  }

  const pdfUrl = pdfPath.startsWith('http') ? pdfPath : `${BASE_URL}${pdfPath}`;

  try {
    const pdfBuffer = await fetchPdfBuffer(pdfUrl, cookie);
    const parsed = await pdf(pdfBuffer);
    const text = sanitizeText(parsed.text);

    const mdContent = [
      `# ${title}`,
      '',
      `- slug: ${slug}`,
      `- date: ${date}`,
      `- pdf: ${pdfUrl}`,
      '',
      '## Extracted Text',
      '',
      text,
      '',
    ].join('\n');

    const outPath = path.join(OUT_DIR, `${slug}.md`);
    await writeFile(outPath, mdContent, 'utf8');

    manifest.push({
      id: String(row.id),
      slug,
      title,
      date,
      pdfUrl,
      markdownPath: outPath,
    });

    console.log(`exported ${slug}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`skip ${slug}: ${message}`);
  }
}

await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\nDone. Exported ${manifest.length} markdown files to ${OUT_DIR}`);

await db.close();
