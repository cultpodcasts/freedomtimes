#!/usr/bin/env bash
# Create a full Turso copy of production EmDash DB for rollback (run from WSL).
# Usage:
#   ./scripts/turso-create-rollback-branch-wsl.sh [production-db-name] [group-name]
# Defaults: freedomtimes-emdash-production, freedomtimes-production
set -euo pipefail

export PATH="${HOME}/.turso:${PATH}"

if ! command -v turso >/dev/null 2>&1; then
  echo "Turso CLI not found. Install: curl -sSfL https://get.tur.so/install.sh | bash" >&2
  exit 1
fi

PROD_DB="${1:-freedomtimes-emdash-production}"
GROUP="${2:-freedomtimes-production}"
NOTES="${TURSO_ROLLBACK_NOTES:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

TIMESTAMP_UTC="$(date -u +%Y%m%d-%H%M%S)"
BRANCH_NAME="${TURSO_ROLLBACK_BRANCH_NAME:-prod-rollback-${TIMESTAMP_UTC}}"

echo "Creating '${BRANCH_NAME}' from '${PROD_DB}' (group: ${GROUP})"
turso db create "${BRANCH_NAME}" --from-db "${PROD_DB}" --group "${GROUP}"

META_DIR="${REPO_ROOT}/.release/rollback-branches"
mkdir -p "${META_DIR}"
META_FILE="${META_DIR}/${TIMESTAMP_UTC}-${BRANCH_NAME}.json"

HEAD="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
ORIGIN_MAIN="$(git rev-parse origin/main 2>/dev/null || echo "")"
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || echo "")"
DIRTY="false"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  DIRTY="true"
fi

CREATED_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

export CREATED_UTC PROD_DB BRANCH_NAME GROUP NOTES META_FILE HEAD SHORT CURRENT_BRANCH ORIGIN_MAIN ORIGIN_URL DIRTY

node -e "
const fs = require('node:fs');
const m = {
  createdAtUtc: process.env.CREATED_UTC,
  sourceDatabase: process.env.PROD_DB,
  rollbackDatabase: process.env.BRANCH_NAME,
  tursoGroup: process.env.GROUP,
  notes: process.env.NOTES || null,
  git: {
    head: process.env.HEAD,
    headShort: process.env.SHORT,
    currentBranch: process.env.CURRENT_BRANCH,
    originMain: process.env.ORIGIN_MAIN,
    originRemote: process.env.ORIGIN_URL,
    dirtyWorkingTree: process.env.DIRTY === 'true',
  },
};
const path = process.env.META_FILE;
fs.writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
console.log(path);
"

echo "Rollback metadata: ${META_FILE}"
echo "Next (if needed): turso db tokens create '${BRANCH_NAME}' for emergency failback."
