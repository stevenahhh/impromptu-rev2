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
    SELECT count(*) = 4 AND bool_and(relrowsecurity) AND bool_and(relforcerowsecurity)
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'private_app'
      AND relation.relname IN (
        'tenants',
        'presentation_sessions',
        'evidence_candidates',
        'publication_outbox'
      )
  ),
  'every tenant-owned private table must force row-level security'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 4
    FROM pg_policies
    WHERE schemaname = 'private_app'
      AND policyname = 'tenant_isolation'
      AND permissive = 'PERMISSIVE'
      AND roles = '{private_app}'
      AND qual LIKE '%app.tenant_id%'
      AND with_check LIKE '%app.tenant_id%'
  ),
  'tenant-owned tables must have fail-closed read and write policies'
);
SELECT pg_temp.assert_true(
  NOT has_schema_privilege('projection_app', 'private_app', 'USAGE'),
  'projection_app must not have private schema usage'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM _migrations.applied_migrations
    WHERE migration_name = '0001_private_foundation.sql'
      AND checksum ~ '^[0-9a-f]{64}$'
  ),
  'private migration must be recorded with a checksum'
);

SELECT 'private catalog and RLS assertions passed' AS result;
