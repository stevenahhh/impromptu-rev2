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

SELECT (count(*) = 0)::integer AS retrieval_missing_context_is_empty
FROM private_app.deck_retrieval_chunks \gset
\if :retrieval_missing_context_is_empty
\else
  \echo 'deck retrieval rows were visible without a tenant context'
  \quit 1
\endif

SELECT (count(*) = 0)::integer AS grants_missing_context_is_empty
FROM private_app.team_question_grants \gset
\if :grants_missing_context_is_empty
\else
  \echo 'team question grants were visible without a tenant or actor context'
  \quit 1
\endif

SELECT (count(*) = 0)::integer AS questions_missing_context_is_empty
FROM private_app.team_questions \gset
\if :questions_missing_context_is_empty
\else
  \echo 'team questions were visible without a tenant context'
  \quit 1
\endif

-- The teammate-targeted read exception: under only app.actor_account_id, teammate B sees
-- exactly its own grant and never teammate C's or another tenant's inbox row.
BEGIN;
SET LOCAL app.actor_account_id = 'account_seed_teammate_b';
SELECT (
  count(*) = 1
  AND bool_and(grant_id = 'tqg_' || repeat('0', 32))
  AND bool_and(teammate_account_id = 'account_seed_teammate_b')
)::integer AS teammate_scoped_grant
FROM private_app.team_question_grants \gset
\if :teammate_scoped_grant
\else
  \echo 'teammate-scoped read exposed another account or missed the targeted grant'
  \quit 1
\endif
SELECT (count(*) = 0)::integer AS teammate_no_inbox
FROM private_app.team_questions \gset
\if :teammate_no_inbox
\else
  \echo 'teammate context leaked inbox question rows'
  \quit 1
\endif
WITH changed AS (
  UPDATE private_app.team_question_grants
  SET revoked_at = transaction_timestamp()
  WHERE grant_id = 'tqg_' || repeat('0', 32)
  RETURNING 1
)
SELECT (count(*) = 0)::integer AS teammate_cannot_revoke FROM changed \gset
\if :teammate_cannot_revoke
\else
  \echo 'a teammate-scoped context revoked a grant'
  \quit 1
\endif
COMMIT;

BEGIN;
SET LOCAL app.actor_account_id = 'account_seed_teammate_c';
SELECT (
  count(*) = 1
  AND bool_and(grant_id = 'tqg_' || repeat('2', 32))
)::integer AS teammate_c_scoped
FROM private_app.team_question_grants \gset
\if :teammate_c_scoped
\else
  \echo 'teammate C did not see exactly its own grant'
  \quit 1
\endif
COMMIT;

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

SELECT (
  count(*) = 1
  AND bool_and(tenant_id = '10000000-0000-4000-8000-000000000001')
  AND bool_and(object_id = 'tenant-a-retrieval-chunk')
  AND bool_and(search_vector @@ plainto_tsquery('simple', 'alpha retrieval'))
)::integer AS tenant_a_retrieval_isolated
FROM private_app.deck_retrieval_chunks \gset
\if :tenant_a_retrieval_isolated
\else
  \echo 'tenant A retrieval context exposed another tenant or FTS was unavailable'
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

SELECT (
  count(*) = 1
  AND bool_and(tenant_id = '20000000-0000-4000-8000-000000000002')
  AND bool_and(object_id = 'tenant-b-retrieval-chunk')
)::integer AS tenant_b_retrieval_isolated
FROM private_app.deck_retrieval_chunks \gset
\if :tenant_b_retrieval_isolated
\else
  \echo 'tenant B retrieval data was missing or modified through tenant A'
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

BEGIN;
SET LOCAL app.tenant_id = '10000000-0000-4000-8000-000000000001';
SELECT (
  count(*) = 1
  AND bool_and(question = 'seeded tenant-A question')
)::integer AS tenant_a_inbox
FROM private_app.team_questions \gset
\if :tenant_a_inbox
\else
  \echo 'tenant A could not read its own seeded question'
  \quit 1
\endif
COMMIT;

SELECT 'private tenant RLS and prepared-evidence state surface passed' AS result;
