#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RUNNER="$REPO_ROOT/tests/database/run.sh"

assert_project_absent() {
  local project="$1"
  local kind resources

  for kind in container network volume; do
    case "$kind" in
      container)
        resources="$(docker ps --all --quiet --filter "label=com.docker.compose.project=$project")"
        ;;
      network)
        resources="$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")"
        ;;
      volume)
        resources="$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")"
        ;;
    esac
    if [[ -n "$resources" ]]; then
      echo "signal cleanup assertion failed: leaked $kind resources for $project" >&2
      exit 1
    fi
  done
}

run_signal_case() {
  local signal="$1"
  local expected_status="$2"
  local iteration="$3"
  local project="impromptu-r2-signal-${signal,,}-$PPID-$$-$iteration"
  local ready_fifo gate_fifo output status ready_fd gate_fd

  ready_fifo="$(mktemp -u)"
  gate_fifo="$(mktemp -u)"
  output="$(mktemp)"
  mkfifo "$ready_fifo" "$gate_fifo"
  exec {ready_fd}<>"$ready_fifo"
  exec {gate_fd}<>"$gate_fifo"

  set +e
  (
    target_pid=$BASHPID
    (
      event=""
      if IFS= read -r -t "${DATABASE_SIGNAL_READY_TIMEOUT:-60}" -u "$ready_fd" event \
        && [[ "$event" == "healthy:$project" ]]; then
        kill -s "$signal" "$target_pid"
      else
        kill -TERM "$target_pid"
      fi
    ) &

    DATABASE_TEST_PROJECT_NAME="$project" \
    DATABASE_TEST_READY_FIFO="$ready_fifo" \
    DATABASE_TEST_HOLD_AFTER_HEALTHY_FIFO="$gate_fifo" \
      exec bash "$RUNNER" >"$output" 2>&1
  )
  status=$?
  set -e

  exec {ready_fd}>&-
  exec {gate_fd}>&-
  rm -f "$ready_fifo" "$gate_fifo"

  if (( status != expected_status )); then
    echo "signal cleanup assertion failed: $signal expected $expected_status, got $status" >&2
    cat "$output" >&2
    rm -f "$output"
    exit 1
  fi
  if grep -q "Database migrations and runtime isolation verified." "$output"; then
    echo "signal cleanup assertion failed: success was printed after $signal" >&2
    cat "$output" >&2
    rm -f "$output"
    exit 1
  fi

  assert_project_absent "$project"
  rm -f "$output"
  echo "$signal cleanup iteration $iteration verified with status $status."
}

for iteration in 1 2; do
  run_signal_case TERM 143 "$iteration"
  run_signal_case INT 130 "$iteration"
done

echo "Repeated TERM and INT cleanup behavior verified."
