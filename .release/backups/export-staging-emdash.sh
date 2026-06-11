#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.dev"
WEB_DIR="${REPO_ROOT}/web"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}" >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  if [[ "$line" =~ ^(TURSO_TOKEN|TURSO_DATABASE_URL|TURSO_AUTH_TOKEN)= ]]; then
    export "$line"
  fi
done < "${ENV_FILE}"

TIMESTAMP_UTC="$(date -u +%Y%m%d-%H%M%S)"
OUT_DB="${REPO_ROOT}/.release/backups/emdash-staging-${TIMESTAMP_UTC}.db"
OUT_SQL="${OUT_DB%.db}.sql"
META_FILE="${OUT_DB%.db}.json"

mkdir -p "${REPO_ROOT}/.release/backups"
export PATH="${HOME}/.turso:${PATH}"

METHOD=""
if command -v turso >/dev/null 2>&1 && [[ -n "${TURSO_TOKEN:-}" ]]; then
  if turso config set token "${TURSO_TOKEN}" >/dev/null 2>&1 && turso auth whoami >/dev/null 2>&1; then
    echo "Exporting freedomtimes-emdash-staging via turso db export..."
    turso db export freedomtimes-emdash-staging --output-file "${OUT_DB}"
    METHOD="turso-db-export"
    OUT_FILE="${OUT_DB}"
  fi
fi

if [[ -z "${METHOD}" ]]; then
  if [[ -z "${TURSO_DATABASE_URL:-}" || -z "${TURSO_AUTH_TOKEN:-}" ]]; then
    echo "Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in .env.dev" >&2
    exit 1
  fi
  echo "Turso platform token unavailable; exporting SQL dump via libsql app credentials..."
  node "${WEB_DIR}/scripts/export-turso-sql-dump.mjs" "${OUT_SQL}"
  METHOD="libsql-sql-dump"
  OUT_FILE="${OUT_SQL}"
fi

HEAD="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
CREATED_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

node -e "
const fs = require('node:fs');
const [meta, created, outFile, method, head] = process.argv.slice(1);
const payload = {
  createdAtUtc: created,
  sourceDatabase: 'freedomtimes-emdash-staging',
  backupFile: outFile,
  method,
  purpose: 'pre-staging-worker-deploy',
  git: { head },
};
fs.writeFileSync(meta, JSON.stringify(payload, null, 2) + '\n');
console.log(meta);
" "${META_FILE}" "${CREATED_UTC}" "${OUT_FILE}" "${METHOD}" "${HEAD}"

ls -lh "${OUT_FILE}"
echo "Backup complete (${METHOD})."
