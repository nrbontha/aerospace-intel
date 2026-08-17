#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
elif [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="${BACKUP_DIR:-"$root/backups"}/$stamp"
mkdir -p "$dest"

"$root/scripts/pg-client.sh" dump >"$dest/database.dump"

storage_path="${STORAGE_PATH:-"$root/storage"}"
if [[ -d "$storage_path" ]]; then
  tar -C "$storage_path" -czf "$dest/storage.tar.gz" .
else
  mkdir -p "$dest/empty-storage"
  tar -C "$dest/empty-storage" -czf "$dest/storage.tar.gz" .
  rmdir "$dest/empty-storage"
fi

checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

db_digest="$(checksum "$dest/database.dump")"
storage_digest="$(checksum "$dest/storage.tar.gz")"
cat >"$dest/manifest.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "databaseDump": "database.dump",
  "databaseSha256": "$db_digest",
  "storageArchive": "storage.tar.gz",
  "storageSha256": "$storage_digest",
  "note": "Restore with scripts/restore.sh. Do not commit this directory."
}
EOF

echo "Backup written to $dest"
