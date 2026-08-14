#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly COMPOSE_FILE="$REPO_ROOT/infra/database/compose.yaml"
readonly DATABASE_NAME="impromptu"
readonly BOOTSTRAP_ROLE="impromptu_bootstrap"
readonly MIGRATION_ROLE="migration"
readonly PROJECTION_ROLE="projection_app"
readonly WORKTREE_TAG="$(basename "$REPO_ROOT" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
readonly PROJECT_NAME="${DATABASE_TEST_PROJECT_NAME:-impromptu-r2-${WORKTREE_TAG}-$$-${RANDOM}}"

mapfile -t migrations < <(find "$REPO_ROOT/infra/migrations" -maxdepth 1 -type f -name '*.sql' 2>/dev/null | sort)
if (( ${#migrations[@]} == 0 )); then
  echo "database test setup failed: no SQL migrations found in infra/migrations" >&2
  exit 1
fi

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

project_resources() {
  local kind="$1"

  case "$kind" in
    container)
      docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME"
      ;;
    network)
      docker network ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME"
      ;;
    volume)
      docker volume ls --quiet --filter "label=com.docker.compose.project=$PROJECT_NAME"
      ;;
  esac
}

cleanup_resources() {
  local cleanup_status=0
  local inspect_status resources kind

  compose down --volumes --remove-orphans >/dev/null 2>&1 || cleanup_status=$?

  if [[ "${DATABASE_TEST_FORCE_CLEANUP_FAILURE:-}" == "1" ]]; then
    cleanup_status=97
  fi

  for kind in container network volume; do
    resources="$(project_resources "$kind")"
    inspect_status=$?
    if (( inspect_status != 0 )); then
      echo "database test cleanup failed: could not inspect $kind resources for $PROJECT_NAME" >&2
      cleanup_status=98
    elif [[ -n "$resources" ]]; then
      echo "database test cleanup failed: leaked $kind resources for $PROJECT_NAME: $resources" >&2
      cleanup_status=98
    fi
  done

  return "$cleanup_status"
}

finish() {
  local original_status=$?
  local cleanup_status=0
  local final_status

  trap - EXIT
  set +e
  cleanup_resources
  cleanup_status=$?
  set -e

  if (( cleanup_status != 0 )); then
    echo "database test cleanup failed with status $cleanup_status" >&2
  fi

  final_status=$original_status
  if (( final_status == 0 )); then
    final_status=$cleanup_status
  fi

  if (( final_status == 0 )); then
    echo "Database migrations and runtime isolation verified."
  fi
  exit "$final_status"
}
trap finish EXIT

compose up --detach --wait --wait-timeout 60

if [[ -n "${DATABASE_TEST_FORCE_TEST_FAILURE:-}" ]]; then
  exit "$DATABASE_TEST_FORCE_TEST_FAILURE"
fi

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
