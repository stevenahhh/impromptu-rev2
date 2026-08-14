#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly COMPOSE_FILE="$REPO_ROOT/infra/database/compose.yaml"
readonly DATABASE_NAME="impromptu"
readonly BOOTSTRAP_ROLE="impromptu_bootstrap"
readonly MIGRATION_ROLE="migration"
readonly PROJECTION_ROLE="projection_app"

mapfile -t migrations < <(find "$REPO_ROOT/infra/migrations" -maxdepth 1 -type f -name '*.sql' 2>/dev/null | sort)
if (( ${#migrations[@]} == 0 )); then
  echo "database test setup failed: no SQL migrations found in infra/migrations" >&2
  exit 1
fi

compose() {
  docker compose --file "$COMPOSE_FILE" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

compose up --detach --wait --wait-timeout 60

for index in "${!migrations[@]}"; do
  role="$MIGRATION_ROLE"
  if (( index == 0 )); then
    role="$BOOTSTRAP_ROLE"
  fi

  echo "Applying $(basename "${migrations[$index]}") as $role"
  compose exec --no-TTY postgres \
    psql --username "$role" --dbname "$DATABASE_NAME" --no-psqlrc --set ON_ERROR_STOP=1 \
    < "${migrations[$index]}"
done

compose exec --no-TTY postgres \
  psql --username private_app --dbname "$DATABASE_NAME" --no-psqlrc --set ON_ERROR_STOP=1 \
  < "$REPO_ROOT/tests/database/seed.sql"

compose exec --no-TTY postgres \
  psql --username "$BOOTSTRAP_ROLE" --dbname "$DATABASE_NAME" --no-psqlrc --set ON_ERROR_STOP=1 \
  < "$REPO_ROOT/tests/database/assertions.sql"

compose exec --no-TTY postgres \
  psql --username "$PROJECTION_ROLE" --dbname "$DATABASE_NAME" --no-psqlrc --set ON_ERROR_STOP=1 \
  < "$REPO_ROOT/tests/database/projection-app.sql"

expect_denied() {
  local label="$1"
  local statement="$2"
  local expected_error="$3"
  local output

  if output="$(compose exec --no-TTY postgres \
    psql --username "$PROJECTION_ROLE" --dbname "$DATABASE_NAME" --no-psqlrc \
    --set ON_ERROR_STOP=1 --command "$statement" 2>&1)"; then
    echo "security assertion failed: projection_app was allowed to $label" >&2
    exit 1
  fi

  if [[ "$output" != *"$expected_error"* ]]; then
    echo "security assertion failed: $label returned an unexpected error" >&2
    echo "$output" >&2
    exit 1
  fi

  echo "DENIED projection_app: $label ($expected_error)"
}

expect_denied \
  "use the private_app schema" \
  "SELECT count(*) FROM private_app.presentation_sessions" \
  "permission denied for schema private_app"
expect_denied \
  "read a private_app table" \
  "SELECT presenter_notes FROM private_app.presentation_sessions" \
  "permission denied for schema private_app"
expect_denied \
  "read a public projection base table" \
  "SELECT count(*) FROM public_projection.projection_sessions" \
  "permission denied for table projection_sessions"
expect_denied \
  "write the receipt base table directly" \
  "INSERT INTO public_projection.display_receipts (projection_id, display_id, revision, command_id, request_hash, status) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', repeat('b', 64), 'stage_applied')" \
  "permission denied for table display_receipts"
expect_denied \
  "assume the private_app role" \
  "SET ROLE private_app" \
  "permission denied to set role"

echo "Database migrations and runtime isolation verified."
