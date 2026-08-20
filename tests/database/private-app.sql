\set ON_ERROR_STOP 1

SELECT (current_database() = 'impromptu_private' AND current_user = 'private_app')::integer
  AS correct_runtime \gset
\if :correct_runtime
\else
  \echo 'private RLS test used the wrong database role or database'
  \quit 1
\endif

SELECT (count(*) = 0)::integer AS missing_context_is_empty
FROM private_app.presentation_sessions \gset
\if :missing_context_is_empty
\else
  \echo 'private rows were visible without a tenant context'
  \quit 1
\endif

BEGIN;
SET LOCAL app.tenant_id = '10000000-0000-4000-8000-000000000001';
SELECT (
  count(*) = 1
  AND bool_and(tenant_id = '10000000-0000-4000-8000-000000000001'::uuid)
  AND bool_and(presenter_notes = 'PRIVATE_CANARY_TENANT_A')
)::integer AS tenant_a_isolated
FROM private_app.presentation_sessions \gset
\if :tenant_a_isolated
\else
  \echo 'tenant A did not receive exactly its own session'
  \quit 1
\endif

WITH changed AS (
  UPDATE private_app.presentation_sessions
  SET presenter_notes = 'CROSS_TENANT_WRITE'
  WHERE tenant_id = '20000000-0000-4000-8000-000000000002'
  RETURNING 1
)
SELECT (count(*) = 0)::integer AS cross_tenant_update_hidden FROM changed \gset
\if :cross_tenant_update_hidden
\else
  \echo 'tenant A updated tenant B data'
  \quit 1
\endif
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '20000000-0000-4000-8000-000000000002';
SELECT (
  count(*) = 1
  AND bool_and(tenant_id = '20000000-0000-4000-8000-000000000002'::uuid)
  AND bool_and(presenter_notes = 'PRIVATE_CANARY_TENANT_B')
)::integer AS tenant_b_isolated
FROM private_app.presentation_sessions \gset
\if :tenant_b_isolated
\else
  \echo 'tenant B data was missing or modified through tenant A'
  \quit 1
\endif
COMMIT;

SELECT (
  count(*) = 1
  AND bool_and(revision = 1)
  AND bool_and(snapshot ->> 'stateKind' = 'PREPARED_EVIDENCE_COORDINATOR_SNAPSHOT')
)::integer AS prepared_evidence_state_visible
FROM private_app.prepared_evidence_state
WHERE state_key = 'database-test' \gset
\if :prepared_evidence_state_visible
\else
  \echo 'private_app could not read the persisted prepared-evidence state'
  \quit 1
\endif

SELECT 'private tenant RLS and prepared-evidence state surface passed' AS result;
