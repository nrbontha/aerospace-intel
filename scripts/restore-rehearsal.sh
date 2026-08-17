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

python3 - "$DATABASE_URL" <<'PY'
import sys, urllib.parse
url = urllib.parse.urlparse(sys.argv[1])
print(f"db_host={url.hostname}")
print(f"db_port={url.port or 5432}")
print(f"db_name={url.path.lstrip('/')}")
print(f"db_user={url.username}")
PY

rehearsal_name="${RESTORE_REHEARSAL_DB:-asi_restore_rehearsal}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="${BACKUP_DIR:-"$root/backups"}/rehearsal-$stamp"
mkdir -p "$work"

echo "Taking rehearsal backup"
BACKUP_DIR="$work" "$root/scripts/backup.sh"
backup_path="$(find "$work" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"

echo "Creating rehearsal database $rehearsal_name"
"$root/scripts/pg-client.sh" dropdb "$rehearsal_name" >/dev/null 2>&1 || true
"$root/scripts/pg-client.sh" createdb "$rehearsal_name"

storage_rehearsal="$work/storage"
mkdir -p "$storage_rehearsal"
"$root/scripts/pg-client.sh" restore "$backup_path/database.dump" "$rehearsal_name"
tar -C "$storage_rehearsal" -xzf "$backup_path/storage.tar.gz"

echo "Comparing table counts"
"$root/scripts/pg-client.sh" psql -Atc "select 'source_companies=' || count(*) from companies;"
docker exec "${ASI_DATABASE_CONTAINER:-aerospace-supplier-intelligence-database-1}" \
  psql -U asi -d "$rehearsal_name" -Atc "select 'rehearsal_companies=' || count(*) from companies;"
"$root/scripts/pg-client.sh" psql -Atc "select 'source_documents=' || count(*) from source_documents;"
docker exec "${ASI_DATABASE_CONTAINER:-aerospace-supplier-intelligence-database-1}" \
  psql -U asi -d "$rehearsal_name" -Atc "select 'rehearsal_documents=' || count(*) from source_documents;"

echo "Dropping rehearsal database"
"$root/scripts/pg-client.sh" dropdb "$rehearsal_name"

echo "Restore rehearsal succeeded for $backup_path"
