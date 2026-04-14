import { createClient } from '@libsql/client';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Mode = 'migrate' | 'seed';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: tsx scripts/apply-scheduler-sql.ts <migrate|seed>');
  process.exit(0);
}

const mode = process.argv[2] as Mode | undefined;

if (mode !== 'migrate' && mode !== 'seed') {
  throw new Error('Usage: tsx scripts/apply-scheduler-sql.ts <migrate|seed>');
}

const schedulerUrl = getRequiredEnv([
  'TURSO_SCHEDULER_DATABASE_URL',
  'TURSO_STAGING_SCHEDULER_DB_URL',
]);
const schedulerAuthToken = getRequiredEnv([
  'TURSO_SCHEDULER_AUTH_TOKEN',
  'TURSO_STAGING_SCHEDULER_DB_TOKEN',
]);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..');
const sqlDir = path.join(repoRoot, 'infra', mode === 'migrate' ? 'migrations' : 'seeds');

const client = createClient({
  url: schedulerUrl,
  authToken: schedulerAuthToken,
});

try {
  const files = (await readdir(sqlDir))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of files) {
    const fullPath = path.join(sqlDir, fileName);
    const sql = await readFile(fullPath, 'utf8');
    const statements = splitSqlStatements(sql);

    for (const statement of statements) {
      await client.execute(statement);
    }

    console.log(`[scheduler-db] applied ${mode} file ${fileName}`);
  }
} finally {
  client.close();
}

function getRequiredEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  throw new Error(`${names.join(' or ')} is required`);
}

function splitSqlStatements(sql: string): string[] {
  const lines = sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'));

  return lines
    .join('\n')
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}