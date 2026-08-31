#!/usr/bin/env bash
# Recoverable Turso backup of the EmDash CMS database before `emdash migrate`.
# Not tips/subscriptions SQL. Not content pt:migrate.
#
# Usage:
#   scripts/ci-turso-emdash-backup.sh <staging|production> <database-name> [group]
#
# Staging: turso db export → .release/backups/
# Production: turso db create --from-db (rollback branch) + metadata JSON
set -euo pipefail

ENVIRONMENT="${1:-}"
DATABASE_NAME="${2:-}"
TURSO_GROUP="${3:-}"

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "Usage: $0 <staging|production> <database-name> [group]" >&2
  exit 1
fi

if [[ -z "$DATABASE_NAME" ]]; then
  echo "EmDash Turso database name is required." >&2
  exit 1
fi

TOKEN=""
if [[ -n "${TURSO_PLATFORM_API_TOKEN:-}" ]]; then
  TOKEN="$TURSO_PLATFORM_API_TOKEN"
elif [[ -n "${TURSO_API_TOKEN:-}" ]]; then
  TOKEN="$TURSO_API_TOKEN"
elif [[ -n "${TF_VAR_turso_api_token:-}" ]]; then
  TOKEN="$TF_VAR_turso_api_token"
elif [[ -n "${TURSO_TOKEN:-}" ]]; then
  if [[ "$TURSO_TOKEN" == eyJ*.*.* ]]; then
    echo "TURSO_TOKEN looks like a libsql database JWT; not using it for CLI auth. Set TURSO_PLATFORM_API_TOKEN." >&2
  else
    TOKEN="$TURSO_TOKEN"
  fi
fi
if [[ -z "$TOKEN" ]]; then
  echo "Missing Turso Platform API token (TURSO_PLATFORM_API_TOKEN / TURSO_API_TOKEN / TF_VAR_turso_api_token / non-JWT TURSO_TOKEN)." >&2
  exit 1
fi

export PATH="${HOME}/.turso:${PATH}"
if ! command -v turso >/dev/null 2>&1; then
  echo "Installing Turso CLI..."
  curl -sSfL https://get.tur.so/install.sh | bash
  export PATH="${HOME}/.turso:${PATH}"
fi

if ! command -v turso >/dev/null 2>&1; then
  echo "Turso CLI is not available after install." >&2
  exit 1
fi

if ! turso config set token "$TOKEN" >/dev/null 2>&1; then
  echo "turso config set token failed (token value not logged)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"

if [[ "$ENVIRONMENT" == "staging" ]]; then
  mkdir -p .release/backups
  OUT="./.release/backups/emdash-staging-${STAMP}.db"
  echo "Exporting staging EmDash Turso '${DATABASE_NAME}' → ${OUT}"
  turso db export "${DATABASE_NAME}" --output-file "${OUT}"
  echo "Staging EmDash backup saved: ${OUT}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "backup_file=${OUT}" >> "${GITHUB_OUTPUT}"
    echo "rollback_branch=" >> "${GITHUB_OUTPUT}"
    echo "rollback_metadata=" >> "${GITHUB_OUTPUT}"
  fi
  exit 0
fi

BRANCH_NAME="ci-rollback-${STAMP}"
echo "Creating production EmDash rollback branch '${BRANCH_NAME}' from '${DATABASE_NAME}'"
CREATE=(turso db create "${BRANCH_NAME}" --from-db "${DATABASE_NAME}")
if [[ -n "$TURSO_GROUP" ]]; then
  CREATE+=(--group "${TURSO_GROUP}")
fi
"${CREATE[@]}"

META_DIR="${REPO_ROOT}/.release/rollback-branches"
mkdir -p "${META_DIR}"
META_FILE="${META_DIR}/${STAMP}-${BRANCH_NAME}.json"
cat > "${META_FILE}" <<EOF
{
  "createdAtUtc": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "sourceDatabase": "${DATABASE_NAME}",
  "rollbackDatabase": "${BRANCH_NAME}",
  "tursoGroup": "${TURSO_GROUP}",
  "notes": "ci-turso-emdash-backup.sh production",
  "git": {
    "head": "${GITHUB_SHA:-}",
    "headShort": "${GITHUB_SHA:-}"
  }
}
EOF
echo "Rollback metadata saved: ${META_FILE}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "backup_file=" >> "${GITHUB_OUTPUT}"
  echo "rollback_branch=${BRANCH_NAME}" >> "${GITHUB_OUTPUT}"
  echo "rollback_metadata=${META_FILE}" >> "${GITHUB_OUTPUT}"
fi
