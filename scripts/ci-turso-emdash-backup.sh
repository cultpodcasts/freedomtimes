#!/usr/bin/env bash
# Recoverable Turso backup of the EmDash CMS database before `emdash migrate`.
# Not tips/subscriptions SQL. Not content pt:migrate.
#
# Usage:
#   scripts/ci-turso-emdash-backup.sh <staging|production> <database-name> [group]
#
# Staging: turso db create --from-db (staging-rollback-STAMP branch; ci-staging-backup-STAMP before 31 Oct 2026). No .db file: this
#          repo is public, so CI never exports or uploads a database file.
# Production: turso db create --from-db (prod-rollback-STAMP branch; ci-rollback-STAMP before
#             31 Oct 2026) + metadata JSON
#
# The Turso CLI is the pinned, sha256-checked release from scripts/ci-install-turso-cli.sh,
# installed with every token variable removed from its environment.
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
  echo "Installing pinned Turso CLI (scripts/ci-install-turso-cli.sh)..."
  env -u TURSO_PLATFORM_API_TOKEN -u TURSO_API_TOKEN -u TF_VAR_turso_api_token -u TURSO_TOKEN \
    -u TOKEN bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-install-turso-cli.sh"
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
  BRANCH_NAME="staging-rollback-${STAMP}"
  echo "Creating staging EmDash backup branch '${BRANCH_NAME}' from '${DATABASE_NAME}' (no .db export)"
  CREATE=(turso db create "${BRANCH_NAME}" --from-db "${DATABASE_NAME}")
  if [[ -n "$TURSO_GROUP" ]]; then
    CREATE+=(--group "${TURSO_GROUP}")
  fi
  "${CREATE[@]}"
  echo "Staging EmDash backup branch: ${BRANCH_NAME}"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "backup_file=" >> "${GITHUB_OUTPUT}"
    echo "rollback_branch=${BRANCH_NAME}" >> "${GITHUB_OUTPUT}"
    echo "rollback_metadata=" >> "${GITHUB_OUTPUT}"
  fi
  exit 0
fi

BRANCH_NAME="prod-rollback-${STAMP}"
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
