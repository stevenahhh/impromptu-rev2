#!/bin/sh
set -eu

: "${BOOTSTRAP_DATABASE_URL:?BOOTSTRAP_DATABASE_URL is required}"
: "${PRIVATE_MIGRATION_DATABASE_URL:?PRIVATE_MIGRATION_DATABASE_URL is required}"
: "${PROJECTION_MIGRATION_DATABASE_URL:?PROJECTION_MIGRATION_DATABASE_URL is required}"

MIGRATIONS_ROOT="${MIGRATIONS_ROOT:-$(CDPATH= cd -- "$(dirname "$0")/../migrations" && pwd)}"

psql_base() {
  database_url="$1"
  shift
  psql "$database_url" --no-psqlrc --set ON_ERROR_STOP=1 "$@"
}

ensure_ledger() {
  database_url="$1"
  psql_base "$database_url" --quiet <<'SQL'
SET ROLE impromptu_owner;
BEGIN;
CREATE SCHEMA IF NOT EXISTS _migrations AUTHORIZATION impromptu_owner;
REVOKE ALL PRIVILEGES ON SCHEMA _migrations FROM PUBLIC;
CREATE TABLE IF NOT EXISTS _migrations.applied_migrations (
  migration_name text PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  applied_by text NOT NULL DEFAULT session_user
);
REVOKE ALL PRIVILEGES ON TABLE _migrations.applied_migrations FROM PUBLIC;
COMMIT;
SQL
}

ledger_exists() {
  database_url="$1"
  result="$(psql_base "$database_url" --quiet --tuples-only --no-align \
    --command "SELECT to_regclass('_migrations.applied_migrations') IS NOT NULL")"
  [ "$result" = "t" ]
}

ledger_checksum() {
  database_url="$1"
  migration_name="$2"
  psql_base "$database_url" --quiet --tuples-only --no-align \
    --command "SET ROLE impromptu_owner; SELECT checksum FROM _migrations.applied_migrations WHERE migration_name = '$migration_name'"
}

record_cluster_migration() {
  migration_name="$1"
  checksum="$2"
  psql_base "$BOOTSTRAP_DATABASE_URL" --quiet <<SQL
SET ROLE impromptu_owner;
INSERT INTO _migrations.applied_migrations (migration_name, checksum)
VALUES ('$migration_name', '$checksum');
SQL
}

apply_cluster_migrations() {
  migration_dir="$MIGRATIONS_ROOT/cluster"
  found=0

  for migration_file in "$migration_dir"/*.sql; do
    [ -f "$migration_file" ] || continue
    found=1
    migration_name="$(basename "$migration_file")"
    checksum="$(sha256sum "$migration_file" | awk '{print $1}')"
    existing=""

    case "$migration_name" in
      *[!A-Za-z0-9_.-]*)
        echo "invalid migration filename: $migration_name" >&2
        exit 1
        ;;
    esac

    if ledger_exists "$BOOTSTRAP_DATABASE_URL"; then
      existing="$(ledger_checksum "$BOOTSTRAP_DATABASE_URL" "$migration_name")"
    fi
    if [ -n "$existing" ]; then
      if [ "$existing" != "$checksum" ]; then
        echo "checksum mismatch for cluster/$migration_name" >&2
        exit 1
      fi
      echo "SKIP cluster/$migration_name"
      continue
    fi

    echo "APPLY cluster/$migration_name"
    psql_base "$BOOTSTRAP_DATABASE_URL" --file "$migration_file"
    ensure_ledger "$BOOTSTRAP_DATABASE_URL"
    record_cluster_migration "$migration_name" "$checksum"
  done

  if [ "$found" -ne 1 ]; then
    echo "no cluster migrations found in $migration_dir" >&2
    exit 1
  fi
}

apply_transactional_migrations() {
  target="$1"
  database_url="$2"
  migration_dir="$MIGRATIONS_ROOT/$target"
  found=0

  ensure_ledger "$database_url"

  for migration_file in "$migration_dir"/*.sql; do
    [ -f "$migration_file" ] || continue
    found=1
    migration_name="$(basename "$migration_file")"
    checksum="$(sha256sum "$migration_file" | awk '{print $1}')"

    case "$migration_name" in
      *[!A-Za-z0-9_.-]*)
        echo "invalid migration filename: $migration_name" >&2
        exit 1
        ;;
    esac

    existing="$(ledger_checksum "$database_url" "$migration_name")"
    if [ -n "$existing" ]; then
      if [ "$existing" != "$checksum" ]; then
        echo "checksum mismatch for $target/$migration_name" >&2
        exit 1
      fi
      echo "SKIP $target/$migration_name"
      continue
    fi

    echo "APPLY $target/$migration_name"
    psql_base "$database_url" --single-transaction \
      --file "$migration_file" \
      --command "INSERT INTO _migrations.applied_migrations (migration_name, checksum) VALUES ('$migration_name', '$checksum')"
  done

  if [ "$found" -ne 1 ]; then
    echo "no $target migrations found in $migration_dir" >&2
    exit 1
  fi
}

apply_cluster_migrations
apply_transactional_migrations private "$PRIVATE_MIGRATION_DATABASE_URL"
apply_transactional_migrations projection "$PROJECTION_MIGRATION_DATABASE_URL"
