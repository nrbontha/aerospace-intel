#!/usr/bin/env bash
# Shared Postgres 17 client routing. Prefer the compose database container so
# host pg_dump 14 cannot abort against server 17.
set -euo pipefail

container_name="${ASI_DATABASE_CONTAINER:-aerospace-supplier-intelligence-database-1}"

parse_database_url() {
  python3 - "$DATABASE_URL" <<'PY'
import sys, urllib.parse
url = urllib.parse.urlparse(sys.argv[1])
print(url.username or "")
print(url.path.lstrip("/") or "")
PY
}

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$container_name"
}

# Usage: pg_cli dump|restore|psql [args]
mode="${1:-}"
shift || true

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

user="$(parse_database_url | sed -n '1p')"
db="$(parse_database_url | sed -n '2p')"

case "$mode" in
  dump)
    if container_running; then
      docker exec "$container_name" pg_dump -U "$user" -d "$db" --format=custom --no-owner
    else
      pg_dump --format=custom --no-owner --dbname="$DATABASE_URL"
    fi
    ;;
  restore)
    dump_file="${1:?dump file required}"
    target_db="${2:-$db}"
    if container_running; then
      docker exec -i "$container_name" pg_restore --clean --if-exists --no-owner -U "$user" -d "$target_db" <"$dump_file"
    else
      pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$dump_file"
    fi
    ;;
  psql)
    if container_running; then
      docker exec -i "$container_name" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 "$@"
    else
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
    fi
    ;;
  createdb)
    name="$1"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid database name" >&2; exit 1; }
    if container_running; then
      docker exec "$container_name" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${name};"
    else
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${name};"
    fi
    ;;
  dropdb)
    name="$1"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "invalid database name" >&2; exit 1; }
    if container_running; then
      docker exec "$container_name" psql -U "$user" -d "$db" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${name};"
    else
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${name};"
    fi
    ;;
  *)
    echo "Usage: pg-client.sh dump|restore|psql|createdb|dropdb" >&2
    exit 1
    ;;
esac
