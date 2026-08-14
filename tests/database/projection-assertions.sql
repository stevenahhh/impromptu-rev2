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
  current_database() = 'impromptu_projection',
  'projection assertions must run in the projection database'
);
SELECT pg_temp.assert_true(
  to_regnamespace('private_app') IS NULL
    AND to_regclass('private_app.presentation_sessions') IS NULL,
  'private schema and relations must be absent from the projection catalog'
);
SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'private_app'
       OR relation.relname IN ('evidence_candidates', 'publication_outbox')
  ),
  'private relation names and size-bearing catalog rows must not be present'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 5 AND bool_and(relrowsecurity) AND bool_and(relforcerowsecurity)
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public_projection'
      AND relation.relname IN (
        'projection_sessions',
        'audience_cards',
        'display_receipts',
        'publication_inbox',
        'applied_publications'
      )
  ),
  'all projection base tables must force row-level security'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 5
    FROM pg_policies
    WHERE schemaname = 'public_projection'
      AND policyname = 'owner_internal'
      AND roles = '{impromptu_owner}'
  ),
  'projection writes must be confined to owner-backed narrow functions'
);
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('private_app', 'public_projection', 'USAGE')
    AND NOT has_table_privilege(
      'private_app',
      'public_projection.projection_sessions',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    AND NOT has_function_privilege(
      'private_app',
      'public_projection.dispatch_publication(uuid,uuid,uuid,text,jsonb)',
      'EXECUTE'
    ),
  'private_app must have no direct projection database surface'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2 AND bool_and(relrowsecurity) AND bool_and(relforcerowsecurity)
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public_projection'
      AND relation.relname IN ('publication_inbox', 'applied_publications')
  ),
  'projection publication inbox tables must force row-level security'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'projection_app',
    'public_projection.projection_sessions',
    'SELECT,INSERT,UPDATE,DELETE'
  )
    AND NOT has_table_privilege(
      'projection_app',
      'public_projection.audience_cards',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    AND has_table_privilege(
      'projection_app',
      'public_projection.published_audience_cards',
      'SELECT'
    ),
  'projection_app must use closed views instead of base tables'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
      AND bool_and(id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
    FROM public_projection.published_audience_cards
  ),
  'only currently published, non-retracted, non-expired cards may be visible'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'publication_dispatcher',
    'public_projection.publication_inbox',
    'SELECT,INSERT,UPDATE,DELETE'
  )
    AND NOT has_table_privilege(
      'publication_dispatcher',
      'public_projection.applied_publications',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    AND has_function_privilege(
      'publication_dispatcher',
      'public_projection.dispatch_publication(uuid,uuid,uuid,text,jsonb)',
      'EXECUTE'
    ),
  'publication_dispatcher must write only through the idempotent function'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 3
    FROM _migrations.applied_migrations
    WHERE migration_name IN (
      '0001_projection_foundation.sql',
      '0002_publication_inbox.sql',
      '0003_dispatcher_only_writes.sql'
    )
      AND checksum ~ '^[0-9a-f]{64}$'
  ),
  'projection migration must be recorded with a checksum'
);

SELECT 'projection catalog and lifecycle assertions passed' AS result;
