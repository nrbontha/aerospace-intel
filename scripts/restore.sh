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
backup_dir="${1:-}"
if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
  echo "Usage: scripts/restore.sh <backup-directory>" >&2
  exit 1
fi

if [[ "${CONFIRM:-}" != "yes" ]]; then
  echo "Refusing to restore without CONFIRM=yes" >&2
  exit 1
fi

dump="$backup_dir/database.dump"
archive="$backup_dir/storage.tar.gz"
manifest="$backup_dir/manifest.json"
if [[ ! -f "$dump" || ! -f "$archive" ]]; then
  echo "Backup is missing database.dump or storage.tar.gz" >&2
  exit 1
fi

checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

if [[ -f "$manifest" ]]; then
  expected_db="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["databaseSha256"])' "$manifest")"
  expected_storage="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["storageSha256"])' "$manifest")"
  actual_db="$(checksum "$dump")"
  actual_storage="$(checksum "$archive")"
  if [[ "$expected_db" != "$actual_db" || "$expected_storage" != "$actual_storage" ]]; then
    echo "Backup digest mismatch; refusing to restore" >&2
    exit 1
  fi
fi

target_db="$(python3 - "$DATABASE_URL" <<'PY'
import sys, urllib.parse
print(urllib.parse.urlparse(sys.argv[1]).path.lstrip("/"))
PY
)"
"$root/scripts/pg-client.sh" restore "$dump" "$target_db"

storage_path="${STORAGE_PATH:-"$root/storage"}"
mkdir -p "$storage_path"
tar -C "$storage_path" -xzf "$archive"

echo "Restore completed into the configured database and STORAGE_PATH"
