import { readFileSync } from 'node:fs';
import pdf from 'pdf-parse';
import { createClient } from '@libsql/client';

const BASE_URL = 'https://staging.freedomtimes.news';

function loadEnv(name, text) {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
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

function normalizeText(text) {
  return String(text)
    .replace(/\r/g, '\n')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isGarbageLine(line) {
  if (line.length < 25) return true;
  if (/^page\s+\d+$/i.test(line)) return true;
  if (/^freedom\s+times$/i.test(line)) return true;
  if (/^[^a-zA-Z]{8,}$/.test(line)) return true;
  return false;
}

function buildSummary(rawText) {
  const cleaned = normalizeText(rawText);
  if (!cleaned) return null;

  const lines = cleaned
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !isGarbageLine(line));

  const body = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!body) return null;

  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 35 && s.length < 220);

  const picked = [];
  for (const sentence of sentences) {
    if (picked.join(' ').length + sentence.length > 420) break;
    picked.push(sentence);
    if (picked.length >= 3) break;
  }

  const summary = (picked.length > 0 ? picked.join(' ') : body.slice(0, 380)).trim();
  return summary.slice(0, 420);
}

async function fetchPdfBytes(url, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed ${response.status} for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

const envText = readFileSync('../.env.dev', 'utf8');
const url = loadEnv('TURSO_DATABASE_URL', envText);
const authToken = loadEnv('TURSO_AUTH_TOKEN', envText);
if (!url || !authToken) {
  throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in .env.dev');
}

let cookie = null;
try {
  cookie = readFileSync('../.cookie', 'utf8').trim();
} catch {
  cookie = null;
}

const db = createClient({ url, authToken });

const mediaRows = (await db.execute('SELECT id, storage_key FROM media')).rows;
const storageById = new Map(mediaRows.map((row) => [String(row.id), String(row.storage_key || '')]));

const archives = (await db.execute(`
  SELECT id, slug, abstract, pdf_file
  FROM ec_archives
  WHERE deleted_at IS NULL
  ORDER BY date ASC, slug ASC
`)).rows;

let updated = 0;
let skipped = 0;

for (const row of archives) {
  const pdfField = parseJson(row.pdf_file);
  const pdfId = pdfField && typeof pdfField.id === 'string' ? pdfField.id : null;
  let pdfPath = pdfField && typeof pdfField.src === 'string' ? pdfField.src : null;

  if (!pdfPath && pdfId) {
    const storageKey = storageById.get(pdfId);
    if (storageKey) {
      pdfPath = `/_emdash/api/media/file/${storageKey}`;
    }
  }

  if (!pdfPath) {
    skipped += 1;
    console.log(`skip ${row.slug}: no pdf path`);
    continue;
  }

  const pdfUrl = pdfPath.startsWith('http') ? pdfPath : `${BASE_URL}${pdfPath}`;

  try {
    const pdfBytes = await fetchPdfBytes(pdfUrl, cookie);
    const parsed = await pdf(pdfBytes);
    const nextAbstract = buildSummary(parsed.text);

    if (!nextAbstract) {
      skipped += 1;
      console.log(`skip ${row.slug}: no extractable summary`);
      continue;
    }

    if (String(row.abstract || '').trim() !== nextAbstract) {
      await db.execute({
        sql: 'UPDATE ec_archives SET abstract = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        args: [nextAbstract, row.id],
      });
      updated += 1;
      console.log(`updated ${row.slug}`);
    } else {
      skipped += 1;
      console.log(`skip ${row.slug}: unchanged`);
    }
  } catch (error) {
    skipped += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`skip ${row.slug}: ${message}`);
  }
}

console.log(`\narchives=${archives.length} updated=${updated} skipped=${skipped}`);
await db.close();
