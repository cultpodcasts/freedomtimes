/**
 * Applies SQL migrations or seeds to the scheduler or subscriptions Turso DB.
 * Before running against any non-throwaway database: create a backup (for example
 * `turso db export <db-name> --output-file ...` or a rollback branch). See
 * `web/CONTENT_PROMOTION_RUNBOOK.md` and `.cursor/rules/database-backup.mdc`.
 */
import { createClient } from '@libsql/client';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type DatabaseTarget = 'scheduler' | 'subscriptions';
type Mode = 'migrate' | 'seed';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: tsx scripts/apply-turso-sql.ts <scheduler|subscriptions> <migrate|seed>');
  process.exit(0);
}

const databaseTarget = process.argv[2] as DatabaseTarget | undefined;
const mode = process.argv[3] as Mode | undefined;

if (!isDatabaseTarget(databaseTarget) || (mode !== 'migrate' && mode !== 'seed')) {
  throw new Error('Usage: tsx scripts/apply-turso-sql.ts <scheduler|subscriptions> <migrate|seed>');
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..');
const sqlDir = path.join(
  repoRoot,
  'infra',
  `${databaseTarget}-database`,
  mode === 'migrate' ? 'migrations' : 'seeds',
);

const client = createClient({
  url: getRequiredEnv(getUrlEnvNames(databaseTarget)),
  authToken: getRequiredEnv(getAuthTokenEnvNames(databaseTarget)),
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

    console.log(`[${databaseTarget}-db] applied ${mode} file ${fileName}`);
  }
} finally {
  client.close();
}

function isDatabaseTarget(value: string | undefined): value is DatabaseTarget {
  return value === 'scheduler' || value === 'subscriptions';
}

function getUrlEnvNames(databaseTarget: DatabaseTarget): string[] {
  return databaseTarget === 'scheduler'
    ? ['TURSO_SCHEDULER_DATABASE_URL', 'TURSO_STAGING_SCHEDULER_DB_URL']
    : ['TURSO_SUBSCRIPTIONS_DATABASE_URL', 'TURSO_STAGING_SUBSCRIPTIONS_DB_URL'];
}

function getAuthTokenEnvNames(databaseTarget: DatabaseTarget): string[] {
  return databaseTarget === 'scheduler'
    ? ['TURSO_SCHEDULER_AUTH_TOKEN', 'TURSO_STAGING_SCHEDULER_DB_TOKEN']
    : ['TURSO_SUBSCRIPTIONS_AUTH_TOKEN', 'TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN'];
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