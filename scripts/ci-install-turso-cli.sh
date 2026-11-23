#!/usr/bin/env bash
# Install a pinned Turso CLI release on a Linux x86_64 GitHub runner and verify its sha256
# before anything runs it. Used by deploy-worker.yml and scripts/ci-turso-emdash-backup.sh.
#
# Never pipe a remote installer into bash here: the pinned tarball is the only thing executed.
# To upgrade: pick a release from https://github.com/tursodatabase/turso-cli/releases, copy the
# sha256 of turso-cli_Linux_x86_64.tar.gz from that release's checksums.txt, update both values.
#
# Run this step WITHOUT secrets in its environment.
#
# --with-sqld also installs the pinned libSQL server (sqld) that `turso dev` starts, for the local
# restore gate (web/scripts/test-content-export-restore.mts). `turso dev` is fully local: no login,
# no Turso Cloud. Upgrade it the same way from https://github.com/tursodatabase/libsql/releases
# (libsql-server-x86_64-unknown-linux-gnu.tar.xz and its .sha256).
set -euo pipefail

WITH_SQLD=0
for arg in "$@"; do
  case "$arg" in
    --with-sqld) WITH_SQLD=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

SQLD_VERSION="libsql-server-v0.24.32"
SQLD_SHA256="71720fc8648c19efef416efebd47145ef59b62e198770533530a858e1336879f"

TURSO_CLI_VERSION="v1.0.34"
TURSO_CLI_SHA256="9eb67f3efece578a6407d1fa535a75e8d7b5cde4f6af3ac1dd79929e99768dc9"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ;;
  *)
    echo "ci-install-turso-cli.sh only supports Linux x86_64 runners (got $(uname -s)-$(uname -m))." >&2
    exit 1
    ;;
esac

dest="${HOME}/.turso"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -sSfL -o "$tmp/turso.tar.gz" \
  "https://github.com/tursodatabase/turso-cli/releases/download/${TURSO_CLI_VERSION}/turso-cli_Linux_x86_64.tar.gz"
echo "${TURSO_CLI_SHA256}  $tmp/turso.tar.gz" | sha256sum --check --strict -

mkdir -p "$dest"
tar -xzf "$tmp/turso.tar.gz" -C "$tmp" turso
install -m 0755 "$tmp/turso" "$dest/turso"
"$dest/turso" --version

if [[ "$WITH_SQLD" == "1" ]]; then
  curl -sSfL -o "$tmp/sqld.tar.xz" \
    "https://github.com/tursodatabase/libsql/releases/download/${SQLD_VERSION}/libsql-server-x86_64-unknown-linux-gnu.tar.xz"
  echo "${SQLD_SHA256}  $tmp/sqld.tar.xz" | sha256sum --check --strict -
  tar -xJf "$tmp/sqld.tar.xz" -C "$tmp" libsql-server-x86_64-unknown-linux-gnu/sqld
  install -m 0755 "$tmp/libsql-server-x86_64-unknown-linux-gnu/sqld" "$dest/sqld"
  "$dest/sqld" --version
fi

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$dest" >> "$GITHUB_PATH"
fi
