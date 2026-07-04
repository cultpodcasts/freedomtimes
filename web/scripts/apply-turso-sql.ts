/**
 * Applies SQL migrations or seeds to the scheduler, subscriptions, or tips Turso DB.
 * Before running against any non-throwaway database: create a backup (for example
 * `turso db export <db-name> --output-file ...` or a rollback branch). See
 * `web/CONTENT_PROMOTION_RUNBOOK.md` and `.cursor/rules/database-backup.mdc`.
 *
 * Production: set `TURSO_SCHEDULER_*`, `TURSO_SUBSCRIPTIONS_*`, and `TURSO_TIPS_*` in `.env.dev`
 * (see repo `.env.dev.example`). Staging fallbacks are only used when those are unset.
 *
 * Pass `--staging` to target staging databases only (prefers `TURSO_STAGING_*` keys).
 */
import { createClient } from '@libsql/client';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvDev } from './lib/load-env-dev.mjs';
loadEnvDev();
import { fileURLToPath } from 'node:url';

type DatabaseTarget = 'scheduler' | 'subscriptions' | 'tips';
type Mode = 'migrate' | 'seed';
type EnvironmentTarget = 'production' | 'staging';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: tsx scripts/apply-turso-sql.ts <scheduler|subscriptions|tips> <migrate|seed> [--staging]');
  process.exit(0);
}

const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const useStaging = process.argv.includes('--staging');
const environmentTarget: EnvironmentTarget = useStaging ? 'staging' : 'production';

const databaseTarget = positionalArgs[0] as DatabaseTarget | undefined;
const mode = positionalArgs[1] as Mode | undefined;

if (!isDatabaseTarget(databaseTarget) || (mode !== 'migrate' && mode !== 'seed')) {
  throw new Error('Usage: tsx scripts/apply-turso-sql.ts <scheduler|subscriptions|tips> <migrate|seed>');
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..');
const sqlDir = path.join(
  repoRoot,
  'infra',
  `${databaseTarget}-database`,
  mode === 'migrate' ? 'migrations' : 'seeds',
);

const urlBinding = pickFirstEnv(getUrlEnvNames(databaseTarget, environmentTarget));
const tokenBinding = pickFirstEnv(getAuthTokenEnvNames(databaseTarget, environmentTarget));
console.log(
  `[${databaseTarget}-db] ${mode} (${environmentTarget}): using ${urlBinding.name} + ${tokenBinding.name}`,
);

const client = createClient({
  url: urlBinding.value,
  authToken: tokenBinding.value,
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
  return value === 'scheduler' || value === 'subscriptions' || value === 'tips';
}

function getUrlEnvNames(databaseTarget: DatabaseTarget, environmentTarget: EnvironmentTarget): string[] {
  if (environmentTarget === 'staging') {
    if (databaseTarget === 'scheduler') {
      return ['TURSO_STAGING_SCHEDULER_DB_URL'];
    }
    if (databaseTarget === 'tips') {
      return ['TURSO_STAGING_TIPS_DB_URL'];
    }
    return ['TURSO_STAGING_SUBSCRIPTIONS_DB_URL'];
  }

  if (databaseTarget === 'scheduler') {
    return ['TURSO_SCHEDULER_DATABASE_URL', 'TURSO_PRODUCTION_SCHEDULER_DB_URL', 'TURSO_STAGING_SCHEDULER_DB_URL'];
  }
  if (databaseTarget === 'tips') {
    return ['TURSO_TIPS_DATABASE_URL', 'TURSO_PRODUCTION_TIPS_DB_URL', 'TURSO_STAGING_TIPS_DB_URL'];
  }
  return ['TURSO_SUBSCRIPTIONS_DATABASE_URL', 'TURSO_PRODUCTION_SUBSCRIPTIONS_DB_URL', 'TURSO_STAGING_SUBSCRIPTIONS_DB_URL'];
}

function getAuthTokenEnvNames(databaseTarget: DatabaseTarget, environmentTarget: EnvironmentTarget): string[] {
  if (environmentTarget === 'staging') {
    if (databaseTarget === 'scheduler') {
      return ['TURSO_STAGING_SCHEDULER_DB_TOKEN'];
    }
    if (databaseTarget === 'tips') {
      return ['TURSO_STAGING_TIPS_DB_TOKEN'];
    }
    return ['TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN'];
  }

  if (databaseTarget === 'scheduler') {
    return ['TURSO_SCHEDULER_AUTH_TOKEN', 'TURSO_PRODUCTION_SCHEDULER_DB_TOKEN', 'TURSO_STAGING_SCHEDULER_DB_TOKEN'];
  }
  if (databaseTarget === 'tips') {
    return ['TURSO_TIPS_AUTH_TOKEN', 'TURSO_PRODUCTION_TIPS_DB_TOKEN', 'TURSO_STAGING_TIPS_DB_TOKEN'];
  }
  return ['TURSO_SUBSCRIPTIONS_AUTH_TOKEN', 'TURSO_PRODUCTION_SUBSCRIPTIONS_DB_TOKEN', 'TURSO_STAGING_SUBSCRIPTIONS_DB_TOKEN'];
}

function pickFirstEnv(names: string[]): { name: string; value: string } {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return { name, value };
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
