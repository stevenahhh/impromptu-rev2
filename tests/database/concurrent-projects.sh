#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RUNNER="$REPO_ROOT/tests/database/run.sh"
readonly PROJECT_A="impromptu-r2-concurrent-a-$PPID-$$"
readonly PROJECT_B="impromptu-r2-concurrent-b-$PPID-$$"
readonly OUTPUT_A="$(mktemp)"
readonly OUTPUT_B="$(mktemp)"

cleanup_outputs() {
  rm -f "$OUTPUT_A" "$OUTPUT_B"
}
trap cleanup_outputs EXIT

assert_project_absent() {
  local project="$1"
  local resources

  resources="$({
    docker ps --all --quiet --filter "label=com.docker.compose.project=$project"
    docker network ls --quiet --filter "label=com.docker.compose.project=$project"
    docker volume ls --quiet --filter "label=com.docker.compose.project=$project"
  })"
  if [[ -n "$resources" ]]; then
    echo "concurrent harness assertion failed: resources leaked for $project" >&2
    exit 1
  fi
}

DATABASE_TEST_PROJECT_NAME="$PROJECT_A" DATABASE_TEST_MODE=smoke \
  bash "$RUNNER" >"$OUTPUT_A" 2>&1 &
pid_a=$!
DATABASE_TEST_PROJECT_NAME="$PROJECT_B" DATABASE_TEST_MODE=smoke \
  bash "$RUNNER" >"$OUTPUT_B" 2>&1 &
pid_b=$!

status_a=0
status_b=0
wait "$pid_a" || status_a=$?
wait "$pid_b" || status_b=$?

if (( status_a != 0 || status_b != 0 )); then
  echo "concurrent harness assertion failed: A=$status_a B=$status_b" >&2
  cat "$OUTPUT_A" "$OUTPUT_B" >&2
  exit 1
fi
if ! grep -q "Database migrations and runtime isolation verified." "$OUTPUT_A" \
  || ! grep -q "Database migrations and runtime isolation verified." "$OUTPUT_B"; then
  echo "concurrent harness assertion failed: a project did not complete" >&2
  cat "$OUTPUT_A" "$OUTPUT_B" >&2
  exit 1
fi

assert_project_absent "$PROJECT_A"
assert_project_absent "$PROJECT_B"

echo "Concurrent Compose projects completed without collision or leaks."
