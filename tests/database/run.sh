#!/usr/bin/env bash
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly COMPOSE_FILE="$REPO_ROOT/infra/database/compose.yaml"
if command -v cygpath >/dev/null 2>&1; then
  readonly COMPOSE_FILE_ARG="$(cygpath --windows "$COMPOSE_FILE")"
else
  readonly COMPOSE_FILE_ARG="$COMPOSE_FILE"
fi
readonly WORKTREE_TAG="$(basename "$REPO_ROOT" | tr '[:upper:]_' '[:lower:]-' | tr -cd 'a-z0-9-')"
readonly PROJECT_NAME="${DATABASE_TEST_PROJECT_NAME:-impromptu-r2-${WORKTREE_TAG}-$$-${RANDOM}}"
readonly BOOTSTRAP_ROLE="impromptu_bootstrap"
readonly PRIVATE_ROLE="private_app"
readonly PROJECTION_ROLE="projection_app"
readonly DISPATCHER_ROLE="publication_dispatcher"
readonly RETENTION_ROLE="retention_worker"
readonly DEFAULT_DATABASE="postgres"
readonly PRIVATE_DATABASE="impromptu_private"
readonly PROJECTION_DATABASE="impromptu_projection"

compose() {
  MSYS_NO_PATHCONV=1 docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE_ARG" "$@"
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

  trap - EXIT TERM INT
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

handle_signal() {
  local signal_status="$1"

  trap - TERM INT
  exit "$signal_status"
}

trap finish EXIT
trap 'handle_signal 143' TERM
trap 'handle_signal 130' INT

psql_file() {
  local role="$1"
  local database="$2"
  local file="$3"

  compose exec --no-TTY postgres \
    psql --username "$role" --dbname "$database" --no-psqlrc --set ON_ERROR_STOP=1 \
    < "$file"
}

psql_value() {
  local role="$1"
  local database="$2"
  local statement="$3"

  compose exec --no-TTY postgres \
    psql --username "$role" --dbname "$database" --no-psqlrc \
      --set ON_ERROR_STOP=1 --tuples-only --no-align --command "$statement"
}

run_migrations() {
  local migrations_root="${1:-/workspace/infra/migrations}"

  compose exec --no-TTY \
    --env "MIGRATIONS_ROOT=$migrations_root" \
    --env "BOOTSTRAP_DATABASE_URL=postgresql:///$DEFAULT_DATABASE?user=$BOOTSTRAP_ROLE" \
    --env "PRIVATE_MIGRATION_DATABASE_URL=postgresql:///$PRIVATE_DATABASE?user=migration" \
    --env "PROJECTION_MIGRATION_DATABASE_URL=postgresql:///$PROJECTION_DATABASE?user=migration" \
    postgres sh /workspace/infra/database/migrate.sh
}

expect_denied() {
  local role="$1"
  local database="$2"
  local label="$3"
  local statement="$4"
  local expected_error="$5"
  local output

  if output="$(compose exec --no-TTY postgres \
    psql --username "$role" --dbname "$database" --no-psqlrc \
      --set ON_ERROR_STOP=1 --command "$statement" 2>&1)"; then
    echo "security assertion failed: $role was allowed to $label" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_error"* ]]; then
    echo "security assertion failed: $label returned an unexpected error" >&2
    echo "$output" >&2
    exit 1
  fi

  echo "DENIED $role: $label ($expected_error)"
}

expect_connection_denied() {
  local role="$1"
  local database="$2"
  local output

  if output="$(compose exec --no-TTY postgres \
    psql --username "$role" --dbname "$database" --no-psqlrc \
      --set ON_ERROR_STOP=1 --command "SELECT 1" 2>&1)"; then
    echo "security assertion failed: $role connected to $database" >&2
    exit 1
  fi
  if [[ "$output" != *"permission denied for database \"$database\""* ]]; then
    echo "security assertion failed: unexpected connection error for $role -> $database" >&2
    echo "$output" >&2
    exit 1
  fi

  echo "DENIED $role: connect to $database"
}

expect_migration_failure() {
  local migrations_root="$1"
  local expected_error="$2"
  local output

  if output="$(run_migrations "$migrations_root" 2>&1)"; then
    echo "migration assertion failed: expected runner failure for $migrations_root" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_error"* ]]; then
    echo "migration assertion failed: unexpected runner error" >&2
    echo "$output" >&2
    exit 1
  fi

  echo "DENIED migration set: $expected_error"
}

compose up --detach --wait --wait-timeout 60

if [[ -n "${DATABASE_TEST_READY_FIFO:-}" ]]; then
  if [[ ! -p "$DATABASE_TEST_READY_FIFO" ]]; then
    echo "database test setup failed: readiness path is not a FIFO" >&2
    exit 1
  fi
  printf 'healthy:%s\n' "$PROJECT_NAME" > "$DATABASE_TEST_READY_FIFO"
fi
if [[ -n "${DATABASE_TEST_HOLD_AFTER_HEALTHY_FIFO:-}" ]]; then
  if [[ ! -p "$DATABASE_TEST_HOLD_AFTER_HEALTHY_FIFO" ]]; then
    echo "database test setup failed: healthy hold path is not a FIFO" >&2
    exit 1
  fi
  IFS= read -r _ < "$DATABASE_TEST_HOLD_AFTER_HEALTHY_FIFO"
fi

if [[ -n "${DATABASE_TEST_FORCE_TEST_FAILURE:-}" ]]; then
  exit "$DATABASE_TEST_FORCE_TEST_FAILURE"
fi

run_migrations

rerun_output="$(run_migrations)"
if [[ "$rerun_output" != *"SKIP private/0001_private_foundation.sql"* \
  || "$rerun_output" != *"SKIP private/0002_publication_dispatcher.sql"* \
  || "$rerun_output" != *"SKIP private/0003_retention_cascade.sql"* \
  || "$rerun_output" != *"SKIP private/0004_accounts.sql"* \
  || "$rerun_output" != *"SKIP private/0005_prepared_evidence_state.sql"* \
  || "$rerun_output" != *"SKIP private/0006_deck_retrieval_chunks.sql"* \
  || "$rerun_output" != *"SKIP private/0007_embedding_dimension.sql"* \
  || "$rerun_output" != *"SKIP private/0008_deck_retrieval_hybrid.sql"* \
  || "$rerun_output" != *"SKIP private/0009_session_reports.sql"* \
  || "$rerun_output" != *"SKIP private/0010_reference_documents.sql"* \
  || "$rerun_output" != *"SKIP private/0011_qa_exchanges.sql"* \
  || "$rerun_output" != *"SKIP projection/0001_projection_foundation.sql"* \
  || "$rerun_output" != *"SKIP projection/0002_publication_inbox.sql"* \
  || "$rerun_output" != *"SKIP projection/0003_dispatcher_only_writes.sql"* \
  || "$rerun_output" != *"SKIP projection/0004_retention_cascade.sql"* \
  || "$rerun_output" != *"SKIP projection/0005_gateway_state.sql"* \
  || "$rerun_output" != *"SKIP projection/0006_display_invitations.sql"* ]]; then
  echo "migration assertion failed: rerun did not skip applied migrations" >&2
  echo "$rerun_output" >&2
  exit 1
fi
echo "Migration ledger rerun verified."

psql_file "$BOOTSTRAP_ROLE" "$DEFAULT_DATABASE" "$REPO_ROOT/tests/database/cluster-assertions.sql"

if [[ "${DATABASE_TEST_MODE:-full}" == "smoke" ]]; then
  exit 0
fi

psql_file "$PRIVATE_ROLE" "$PRIVATE_DATABASE" "$REPO_ROOT/tests/database/private-seed.sql"
psql_file "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" "$REPO_ROOT/tests/database/projection-seed.sql"

readonly DATABASE_HOST_PORT="$(compose port postgres 5432)"
readonly DATABASE_PORT="${DATABASE_HOST_PORT##*:}"
readonly PRIVATE_DRIVER_URL="postgresql://$BOOTSTRAP_ROLE:local-test-only@127.0.0.1:$DATABASE_PORT/$PRIVATE_DATABASE"
readonly PROJECTION_DRIVER_URL="postgresql://$BOOTSTRAP_ROLE:local-test-only@127.0.0.1:$DATABASE_PORT/$PROJECTION_DATABASE"

run_real_dispatch() {
  local mode="$1"
  PRIVATE_DATABASE_URL="$PRIVATE_DRIVER_URL" \
    PROJECTION_DATABASE_URL="$PROJECTION_DRIVER_URL" \
    bun run "$REPO_ROOT/services/private-backend/test/support/dispatch-integration.ts" "$mode"
}

PRIVATE_DATABASE_URL="$PRIVATE_DRIVER_URL" \
  PROJECTION_DATABASE_URL="$PROJECTION_DRIVER_URL" \
  bun run "$REPO_ROOT/tests/database/state-store-integration.ts"
PRIVATE_DATABASE_URL="$PRIVATE_DRIVER_URL" \
  bun run "$REPO_ROOT/tests/database/session-report-store-integration.ts"
PRIVATE_DATABASE_URL="$PRIVATE_DRIVER_URL" \
  bun run "$REPO_ROOT/tests/database/deck-retrieval-integration.ts"

run_real_dispatch valid

set +e
PRIVATE_DATABASE_URL="$PRIVATE_DRIVER_URL" \
  PROJECTION_DATABASE_URL="$PROJECTION_DRIVER_URL" \
  bun run "$REPO_ROOT/services/private-backend/test/support/dispatch-integration.ts" crash
crash_status=$?
set -e
if (( crash_status != 86 )); then
  echo "dispatcher crash assertion failed: expected status 86, got $crash_status" >&2
  exit 1
fi

undelivered_after_crash="$(psql_value "$BOOTSTRAP_ROLE" "$PRIVATE_DATABASE" \
  "SELECT count(*) FROM private_app.publication_outbox WHERE delivered_at IS NULL")"
applied_after_crash="$(psql_value "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" \
  "SELECT count(*) FROM public_projection.applied_publications WHERE dispatch_key = '33333333-3333-4333-8333-333333333334'")"
if [[ "$undelivered_after_crash" != "1" || "$applied_after_crash" != "1" ]]; then
  echo "dispatcher crash assertion failed: undelivered=$undelivered_after_crash applied=$applied_after_crash" >&2
  exit 1
fi

run_real_dispatch replay

delivery_count="$(psql_value "$BOOTSTRAP_ROLE" "$PRIVATE_DATABASE" \
  "SELECT count(*) FROM private_app.publication_outbox WHERE delivered_at IS NOT NULL")"
inbox_shape="$(psql_value "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" \
  "SELECT count(*) || ':' || count(DISTINCT dispatch_key) || ':' || bool_and(jsonb_typeof(public_payload) = 'object') FROM public_projection.publication_inbox WHERE dispatch_key IN ('33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333334')")"
applied_shape="$(psql_value "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" \
  "SELECT count(*) || ':' || count(DISTINCT dispatch_key) FROM public_projection.applied_publications WHERE dispatch_key IN ('33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333334')")"
if [[ "$delivery_count" != "2" || "$inbox_shape" != "2:2:true" || "$applied_shape" != "2:2" ]]; then
  echo "real dispatcher assertion failed: delivered=$delivery_count inbox=$inbox_shape applied=$applied_shape" >&2
  exit 1
fi
echo "Real PostgreSQL dispatch and crash/restart replay verified."
psql_file "$BOOTSTRAP_ROLE" "$PRIVATE_DATABASE" "$REPO_ROOT/tests/database/private-assertions.sql"
psql_file "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" "$REPO_ROOT/tests/database/projection-assertions.sql"
psql_file "$PRIVATE_ROLE" "$PRIVATE_DATABASE" "$REPO_ROOT/tests/database/private-app.sql"
psql_file "$PROJECTION_ROLE" "$PROJECTION_DATABASE" "$REPO_ROOT/tests/database/projection-app.sql"
psql_file "$DISPATCHER_ROLE" "$PROJECTION_DATABASE" "$REPO_ROOT/tests/database/dispatcher-app.sql"

expect_connection_denied "$PROJECTION_ROLE" "$PRIVATE_DATABASE"
expect_connection_denied "$PROJECTION_ROLE" "$DEFAULT_DATABASE"
expect_connection_denied "$PROJECTION_ROLE" "template1"
expect_connection_denied "$PRIVATE_ROLE" "$PROJECTION_DATABASE"
expect_connection_denied "$PRIVATE_ROLE" "$DEFAULT_DATABASE"
expect_connection_denied "$PRIVATE_ROLE" "template1"
expect_connection_denied "migration" "$DEFAULT_DATABASE"
expect_connection_denied "migration" "template1"
expect_connection_denied "$DISPATCHER_ROLE" "$DEFAULT_DATABASE"
expect_connection_denied "$DISPATCHER_ROLE" "template1"
expect_denied \
  "$PROJECTION_ROLE" "$PROJECTION_DATABASE" \
  "measure the private database" \
  "SELECT pg_catalog.pg_database_size('impromptu_private')" \
  "permission denied for database impromptu_private"
expect_denied \
  "$PROJECTION_ROLE" "$PROJECTION_DATABASE" \
  "read a public projection base table" \
  "SELECT count(*) FROM public_projection.projection_sessions" \
  "permission denied for table projection_sessions"
expect_denied \
  "$PROJECTION_ROLE" "$PROJECTION_DATABASE" \
  "read the gateway state base table directly" \
  "SELECT count(*) FROM public_projection.gateway_state" \
  "permission denied for table gateway_state"
expect_denied \
  "$PROJECTION_ROLE" "$PROJECTION_DATABASE" \
  "write the receipt base table directly" \
  "INSERT INTO public_projection.display_receipts (projection_id, display_id, revision, command_id, request_hash, status) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', repeat('b', 64), 'stage_applied')" \
  "permission denied for table display_receipts"
expect_denied \
  "$PROJECTION_ROLE" "$PROJECTION_DATABASE" \
  "assume the private_app role" \
  "SET ROLE private_app" \
  "permission denied to set role"
expect_denied \
  "$PROJECTION_ROLE" "$PROJECTION_DATABASE" \
  "create a PostgreSQL large object" \
  "SELECT pg_catalog.lo_create(0)" \
  "permission denied for function lo_create"
expect_denied \
  "$PROJECTION_ROLE" "$PROJECTION_DATABASE" \
  "create a PostgreSQL large object from bytes" \
  "SELECT pg_catalog.lo_from_bytea(0, decode('00', 'hex'))" \
  "permission denied for function lo_from_bytea"
expect_denied \
  "$DISPATCHER_ROLE" "$PROJECTION_DATABASE" \
  "reuse a dispatch key with conflicting content" \
  "SELECT public_projection.dispatch_publication('70000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'publish_card', '{\"title\":\"Conflicting publication\"}'::jsonb)" \
  "dispatch key conflicts with the accepted publication"
expect_denied \
  "$DISPATCHER_ROLE" "$PROJECTION_DATABASE" \
  "write the projection inbox directly" \
  "INSERT INTO public_projection.publication_inbox (dispatch_key, tenant_id, projection_id, event_kind, public_payload) VALUES ('70000000-0000-4000-8000-000000000099', '10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'publish_card', '{}'::jsonb)" \
  "permission denied for table publication_inbox"
expect_denied \
  "$DISPATCHER_ROLE" "$PRIVATE_DATABASE" \
  "read private presentation sessions" \
  "SELECT count(*) FROM private_app.presentation_sessions" \
  "permission denied for table presentation_sessions"
expect_denied \
  "$DISPATCHER_ROLE" "$PRIVATE_DATABASE" \
  "insert a private outbox row" \
  "INSERT INTO private_app.publication_outbox (tenant_id, outbox_id, projection_id, event_kind, public_payload) VALUES ('10000000-0000-4000-8000-000000000001', '66666666-6666-4666-8666-666666666666', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'publish_card', '{}'::jsonb)" \
  "permission denied for table publication_outbox"
expect_denied \
  "$PRIVATE_ROLE" "$PRIVATE_DATABASE" \
  "insert a tenant B row while scoped to tenant A" \
  "BEGIN; SET LOCAL app.tenant_id = '10000000-0000-4000-8000-000000000001'; INSERT INTO private_app.presentation_sessions (tenant_id, session_id, owner_subject, presentation_session_epoch, deck_storage_uri) VALUES ('20000000-0000-4000-8000-000000000002', '55555555-5555-4555-8555-555555555555', 'cross-tenant', 1, 'private-decks/cross-tenant.pptx'); COMMIT" \
  "violates row-level security policy"
expect_denied \
  "$PRIVATE_ROLE" "$PRIVATE_DATABASE" \
  "insert a tenant row without tenant context" \
  "INSERT INTO private_app.tenants (tenant_id, display_name) VALUES ('30000000-0000-4000-8000-000000000003', 'No context')" \
  "violates row-level security policy"
expect_denied \
  "$PRIVATE_ROLE" "$PRIVATE_DATABASE" \
  "insert a tenant B retrieval row while scoped to tenant A" \
  "BEGIN; SET LOCAL app.tenant_id = '10000000-0000-4000-8000-000000000001'; INSERT INTO private_app.deck_retrieval_chunks (tenant_id, object_id, source_id, source_revision, source_hash, deck_version, manifest_hash, title, anchor, content, embedding, authorization_version) VALUES ('20000000-0000-4000-8000-000000000002', 'cross-tenant-retrieval', 'slide-cross', repeat('a', 64), repeat('b', 64), 'deck-cross', repeat('c', 64), 'Cross tenant', 'slide=1&chunk=1', 'cross tenant retrieval', array_fill(0.1::double precision, ARRAY[768]), 'acl-1'); COMMIT" \
  "violates row-level security policy"
compose exec --no-TTY postgres sh -eu -c '
  pids=""
  for worker in 1 2 3 4 5 6 7 8; do
    psql --username projection_app --dbname impromptu_projection --no-psqlrc \
      --set ON_ERROR_STOP=1 --tuples-only --no-align \
      --command "SELECT count(*) FROM public_projection.record_display_receipt(
        '\''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'\'',
        '\''dddddddd-dddd-4ddd-8ddd-dddddddddddd'\'',
        20,
        '\''ffffffff-ffff-4fff-8fff-ffffffffffff'\'',
        repeat('\''e'\'', 64),
        '\''stage_applied'\''
      )" > "/tmp/receipt-$worker.out" &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid"; done
  for worker in 1 2 3 4 5 6 7 8; do grep -qx 1 "/tmp/receipt-$worker.out"; done
'
receipt_count="$(psql_value "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" \
  "SELECT count(*) FROM public_projection.display_receipts WHERE revision = 20")"
if [[ "$receipt_count" != "1" ]]; then
  echo "receipt concurrency assertion failed: expected one stored receipt, got $receipt_count" >&2
  exit 1
fi
echo "Concurrent idempotent receipt writes verified."

compose exec --no-TTY postgres sh -eu -c '
  pids=""
  for worker in 1 2 3 4 5 6 7 8; do
    psql --username publication_dispatcher --dbname impromptu_projection --no-psqlrc \
      --set ON_ERROR_STOP=1 --tuples-only --no-align \
      --command "SELECT public_projection.dispatch_publication(
        '\''70000000-0000-4000-8000-000000000020'\'',
        '\''10000000-0000-4000-8000-000000000001'\'',
        '\''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'\'',
        '\''publish_card'\'',
        '\''{\"title\":\"Concurrent publication\"}'\''::jsonb
      )" > "/tmp/dispatch-$worker.out" &
    pids="$pids $!"
  done
  for pid in $pids; do wait "$pid"; done
  applied=0
  duplicate=0
  for worker in 1 2 3 4 5 6 7 8; do
    if grep -qx APPLIED "/tmp/dispatch-$worker.out"; then
      applied=$((applied + 1))
    elif grep -qx DUPLICATE "/tmp/dispatch-$worker.out"; then
      duplicate=$((duplicate + 1))
    else
      cat "/tmp/dispatch-$worker.out" >&2
      exit 1
    fi
  done
  test "$applied" -eq 1
  test "$duplicate" -eq 7
'
inbox_count="$(psql_value "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" \
  "SELECT count(*) FROM public_projection.publication_inbox WHERE dispatch_key = '70000000-0000-4000-8000-000000000020'")"
applied_count="$(psql_value "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" \
  "SELECT count(*) FROM public_projection.applied_publications WHERE dispatch_key = '70000000-0000-4000-8000-000000000020'")"
if [[ "$inbox_count" != "1" || "$applied_count" != "1" ]]; then
  echo "publication concurrency assertion failed: inbox=$inbox_count applied=$applied_count" >&2
  exit 1
fi
echo "Concurrent projection dispatch deduplication verified."

psql_file "$RETENTION_ROLE" "$PRIVATE_DATABASE" "$REPO_ROOT/tests/database/private-retention.sql"
psql_file "$RETENTION_ROLE" "$PROJECTION_DATABASE" "$REPO_ROOT/tests/database/projection-retention.sql"
retention_shape="$(psql_value "$BOOTSTRAP_ROLE" "$PRIVATE_DATABASE" \
  "SELECT (SELECT count(*) FROM private_app.presentation_sessions WHERE tenant_id = '10000000-0000-4000-8000-000000000001') || ':' || (SELECT count(*) FROM private_app.evidence_candidates WHERE tenant_id = '10000000-0000-4000-8000-000000000001') || ':' || (SELECT count(*) FROM private_app.publication_outbox WHERE tenant_id = '10000000-0000-4000-8000-000000000001') || ':' || (SELECT count(*) FROM private_app.presentation_sessions WHERE tenant_id = '20000000-0000-4000-8000-000000000002')")"
projection_retention_shape="$(psql_value "$BOOTSTRAP_ROLE" "$PROJECTION_DATABASE" \
  "SELECT (SELECT count(*) FROM public_projection.projection_sessions WHERE tenant_id = '10000000-0000-4000-8000-000000000001') || ':' || (SELECT count(*) FROM public_projection.publication_inbox WHERE tenant_id = '10000000-0000-4000-8000-000000000001') || ':' || (SELECT count(*) FROM public_projection.projection_sessions WHERE tenant_id = '20000000-0000-4000-8000-000000000002')")"
if [[ "$retention_shape" != "0:0:0:1" || "$projection_retention_shape" != "0:0:1" ]]; then
  echo "retention isolation assertion failed: private=$retention_shape projection=$projection_retention_shape" >&2
  exit 1
fi
expect_denied \
  "$RETENTION_ROLE" "$PRIVATE_DATABASE" \
  "read private rows directly" \
  "SELECT count(*) FROM private_app.presentation_sessions" \
  "permission denied for table presentation_sessions"
expect_denied \
  "$RETENTION_ROLE" "$PROJECTION_DATABASE" \
  "read projection rows directly" \
  "SELECT count(*) FROM public_projection.projection_sessions" \
  "permission denied for table projection_sessions"
echo "Tenant-scoped cross-database retention cascade verified."

readonly DRIFT_ROOT="/tmp/migrations-drift-$$"
compose exec --no-TTY postgres sh -eu -c \
  "cp -R /workspace/infra/migrations '$DRIFT_ROOT'; printf '\n-- checksum drift\n' >> '$DRIFT_ROOT/private/0001_private_foundation.sql'"
expect_migration_failure "$DRIFT_ROOT" "checksum mismatch for private/0001_private_foundation.sql"
compose exec --no-TTY postgres rm -rf "$DRIFT_ROOT"

readonly INTERRUPTION_ROOT="/tmp/migrations-interruption-$$"
compose exec --no-TTY postgres sh -eu -c \
  "cp -R /workspace/infra/migrations '$INTERRUPTION_ROOT'; cp /workspace/tests/database/fixtures/9999_interrupted.sql '$INTERRUPTION_ROOT/private/9999_interrupted.sql'"
expect_migration_failure "$INTERRUPTION_ROOT" "server closed the connection unexpectedly"
rollback_ok="$(psql_value "$BOOTSTRAP_ROLE" "$PRIVATE_DATABASE" \
  "SELECT to_regclass('private_app.interruption_probe') IS NULL AND NOT EXISTS (SELECT 1 FROM _migrations.applied_migrations WHERE migration_name = '9999_interrupted.sql')")"
if [[ "$rollback_ok" != "t" ]]; then
  echo "migration interruption assertion failed: DDL or ledger row survived rollback" >&2
  exit 1
fi
compose exec --no-TTY postgres rm -rf "$INTERRUPTION_ROOT"
echo "Checksum drift and transactional migration rollback verified."
