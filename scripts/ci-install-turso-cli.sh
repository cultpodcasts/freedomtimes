#!/usr/bin/env bash
# Install a pinned Turso CLI release on a Linux x86_64 GitHub runner and verify its sha256
# before anything runs it. Used by deploy-worker.yml and scripts/ci-turso-emdash-backup.sh.
#
# Never pipe a remote installer into bash here: the pinned tarball is the only thing executed.
# To upgrade: pick a release from https://github.com/tursodatabase/turso-cli/releases, copy the
# sha256 of turso-cli_Linux_x86_64.tar.gz from that release's checksums.txt, update both values.
#
# Run this step WITHOUT secrets in its environment.
set -euo pipefail

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

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$dest" >> "$GITHUB_PATH"
fi
