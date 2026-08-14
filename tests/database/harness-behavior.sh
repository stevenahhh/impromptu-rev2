#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RUNNER="$REPO_ROOT/tests/database/run.sh"

assert_project_absent() {
  local project="$1"
  local kind ids

  for kind in container network volume; do
    case "$kind" in
      container)
        ids="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$project")"
        ;;
      network)
        ids="$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")"
        ;;
      volume)
        ids="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")"
        ;;
    esac

    if [[ -n "$ids" ]]; then
      echo "harness behavior assertion failed: leaked $kind resources for $project" >&2
      exit 1
    fi
  done
}

run_expected_failure() {
  local project="$1"
  local expected_status="$2"
  shift 2
  local output status

  set +e
  output="$(env DATABASE_TEST_PROJECT_NAME="$project" "$@" bash "$RUNNER" 2>&1)"
  status=$?
  set -e

  if (( status != expected_status )); then
    echo "harness behavior assertion failed: expected $expected_status, got $status" >&2
    echo "$output" >&2
    exit 1
  fi
  if [[ "$output" == *"Database migrations and runtime isolation verified."* ]]; then
    echo "harness behavior assertion failed: success was printed after a failure" >&2
    exit 1
  fi

  assert_project_absent "$project"
}

readonly FAILURE_PROJECT="impromptu-r2-preserve-$PPID-$$"
run_expected_failure \
  "$FAILURE_PROJECT" \
  42 \
  DATABASE_TEST_MODE=smoke \
  DATABASE_TEST_FORCE_TEST_FAILURE=42 \
  DATABASE_TEST_FORCE_CLEANUP_FAILURE=1

readonly CLEANUP_PROJECT="impromptu-r2-cleanup-$PPID-$$"
run_expected_failure \
  "$CLEANUP_PROJECT" \
  97 \
  DATABASE_TEST_MODE=smoke \
  DATABASE_TEST_FORCE_CLEANUP_FAILURE=1

echo "Harness failure and cleanup behavior verified."
