\set ON_ERROR_STOP 1

CREATE FUNCTION pg_temp.assert_true(condition boolean, message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'assertion failed: %', message;
  END IF;
END;
$$;

SELECT pg_temp.assert_true(
  current_database() = 'impromptu_private',
  'private assertions must run in the private database'
);
SELECT pg_temp.assert_true(
  to_regnamespace('public_projection') IS NULL
    AND to_regclass('public_projection.projection_sessions') IS NULL,
  'projection relations must not exist in the private catalog'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 8 AND bool_and(relrowsecurity) AND bool_and(relforcerowsecurity)
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'private_app'
      AND relation.relname IN (
        'tenants',
        'presentation_sessions',
        'evidence_candidates',
        'publication_outbox',
        'slide_visits',
        'session_report_state',
        'team_question_grants',
        'team_questions'
      )
  ),
  'every tenant-owned private table must force row-level security'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 8
    FROM pg_policies
    WHERE schemaname = 'private_app'
      AND tablename IN (
        'tenants',
        'presentation_sessions',
        'evidence_candidates',
        'publication_outbox',
        'slide_visits',
        'session_report_state',
        'team_question_grants',
        'team_questions'
      )
      AND policyname = 'tenant_isolation'
      AND permissive = 'PERMISSIVE'
      AND roles = '{private_app}'
      AND qual LIKE '%app.tenant_id%'
      AND with_check LIKE '%app.tenant_id%'
  ),
  'tenant-owned tables must have fail-closed read and write policies'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'private_app'
      AND tablename = 'team_question_grants'
      AND policyname = 'teammate_target'
      AND permissive = 'PERMISSIVE'
      AND cmd = 'SELECT'
      AND roles = '{private_app}'
      AND qual LIKE '%app.actor_account_id%'
      AND qual LIKE '%teammate_account_id%'
  )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'private_app'
        AND tablename = 'team_questions'
        AND policyname <> 'tenant_isolation'
        AND roles <> '{impromptu_owner}'
    ),
  'the only cross-tenant read must be the teammate-pinned SELECT on grants; the inbox table admits tenant context only'
);
SELECT pg_temp.assert_true(
  has_table_privilege(
    'private_app',
    'private_app.team_question_grants',
    'SELECT,INSERT,UPDATE'
  )
    AND NOT has_table_privilege('private_app', 'private_app.team_question_grants', 'DELETE')
    AND has_table_privilege('private_app', 'private_app.team_questions', 'SELECT,INSERT')
    AND NOT has_table_privilege(
      'private_app',
      'private_app.team_questions',
      'UPDATE,DELETE'
    ),
  'grant rows must be revocable but never deletable; question rows must be append-only'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'private_app'
      AND tablename = 'team_question_grants'
      AND indexdef LIKE '%UNIQUE%invitation_digest%'
  )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'private_app.team_question_grants'::regclass
        AND contype = 'f'
        AND confrelid = 'private_app.presentation_sessions'::regclass
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'private_app.team_question_grants'::regclass
        AND contype = 'f'
        AND confrelid = 'private_app.accounts'::regclass
    )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'private_app.team_questions'::regclass
        AND contype = 'f'
        AND confrelid = 'private_app.team_question_grants'::regclass
    ),
  'grants must pin a unique invitation digest and reference sessions, accounts and the parent grant'
);
SELECT pg_temp.assert_true(
  (
    SELECT relrowsecurity AND relforcerowsecurity
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'private_app'
      AND relation.relname = 'deck_retrieval_chunks'
  ),
  'deck retrieval chunks must force row-level security'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'private_app'
      AND tablename = 'deck_retrieval_chunks'
      AND policyname = 'tenant_isolation'
      AND permissive = 'PERMISSIVE'
      AND roles = '{private_app}'
      AND qual LIKE '%app.tenant_id%'
      AND qual NOT LIKE '%uuid%'
      AND with_check LIKE '%app.tenant_id%'
      AND with_check NOT LIKE '%uuid%'
  ),
  'text deck retrieval tenants must use a fail-closed text RLS policy'
);
SELECT pg_temp.assert_true(
  has_table_privilege(
    'publication_dispatcher',
    'private_app.publication_outbox',
    'SELECT,UPDATE'
  )
    AND NOT has_table_privilege(
      'publication_dispatcher',
      'private_app.publication_outbox',
      'INSERT,DELETE'
    )
    AND NOT has_table_privilege(
      'publication_dispatcher',
      'private_app.presentation_sessions',
      'SELECT,INSERT,UPDATE,DELETE'
    ),
  'publication_dispatcher must have only claim and delivery access to the outbox'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'retention_worker',
    'private_app.apply_retention(uuid,timestamptz)',
    'EXECUTE'
  )
    AND NOT has_table_privilege(
      'retention_worker',
      'private_app.presentation_sessions',
      'SELECT,INSERT,UPDATE,DELETE'
    ),
  'retention worker must use only the tenant-scoped retention function'
);
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('projection_app', 'private_app', 'USAGE'),
  'projection_app must not have private schema usage'
);
SELECT pg_temp.assert_true(
  NOT (
    SELECT relrowsecurity
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'private_app'
      AND relation.relname = 'prepared_evidence_state'
  )
    AND has_table_privilege(
      'private_app',
      'private_app.prepared_evidence_state',
      'SELECT,INSERT,UPDATE'
    )
    AND NOT has_table_privilege(
      'private_app',
      'private_app.prepared_evidence_state',
      'DELETE'
    ),
  'private runtime must have only the required service-state privileges'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'private_app.deck_retrieval_chunks'::regclass
      AND conname = 'deck_retrieval_chunks_embedding_dimension_check'
      AND pg_get_constraintdef(oid) LIKE '%cardinality(embedding) = 768%'
  ),
  'deck retrieval embeddings must have exactly 768 dimensions'
);
SELECT pg_temp.assert_true(
  (
    SELECT is_generated = 'ALWAYS' AND data_type = 'tsvector'
    FROM information_schema.columns
    WHERE table_schema = 'private_app'
      AND table_name = 'deck_retrieval_chunks'
      AND column_name = 'search_vector'
  ),
  'deck retrieval FTS must use a generated tsvector column'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'private_app'
      AND tablename = 'deck_retrieval_chunks'
      AND indexname = 'deck_retrieval_search_vector_idx'
      AND indexdef LIKE '%USING gin (search_vector)%'
  ),
  'deck retrieval FTS must have a GIN index'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 12
    FROM _migrations.applied_migrations
    WHERE migration_name IN (
      '0001_private_foundation.sql',
      '0002_publication_dispatcher.sql',
      '0003_retention_cascade.sql',
      '0004_accounts.sql',
      '0005_prepared_evidence_state.sql',
      '0006_deck_retrieval_chunks.sql',
      '0007_embedding_dimension.sql',
      '0008_deck_retrieval_hybrid.sql',
      '0009_session_reports.sql',
      '0010_reference_documents.sql',
      '0011_qa_exchanges.sql',
      '0012_team_questions.sql'
    )
      AND checksum ~ '^[0-9a-f]{64}$'
  ),
  'private migrations must be recorded with checksums'
);

SELECT pg_temp.assert_true(
  has_table_privilege('private_app', 'private_app.slide_visits', 'SELECT,INSERT')
    AND NOT has_table_privilege('private_app', 'private_app.slide_visits', 'UPDATE,DELETE')
    AND has_table_privilege('private_app', 'private_app.session_report_state', 'SELECT,INSERT,UPDATE')
    AND NOT has_table_privilege('private_app', 'private_app.session_report_state', 'DELETE'),
  'report tables must permit append-only visits and CAS-only state updates'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'private_app'
      AND table_name = 'session_report_state'
      AND column_name IN ('transcript', 'raw_audio', 'partial')
  ),
  'report state must not persist transcript, raw audio, or partial columns'
);
SELECT pg_temp.assert_true(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'private_app.slide_visits'::regclass
      AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%'
  )
    AND EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'private_app.session_report_state'::regclass
        AND pg_get_constraintdef(oid) LIKE '%ON DELETE CASCADE%'
    ),
  'report rows must cascade with their presentation session'
);

SELECT 'private catalog and RLS assertions passed' AS result;
