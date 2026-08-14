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
  (
    SELECT count(*) = 4
      AND bool_and(NOT rolsuper)
      AND bool_and(NOT rolcreatedb)
      AND bool_and(NOT rolcreaterole)
      AND bool_and(NOT rolreplication)
      AND bool_and(NOT rolbypassrls)
    FROM pg_roles
    WHERE rolname IN ('impromptu_owner', 'migration', 'private_app', 'projection_app')
  ),
  'application roles must not have administrative capabilities'
);
SELECT pg_temp.assert_true(
  (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname = 'impromptu_owner'),
  'object owner must not log in'
);
SELECT pg_temp.assert_true(
  (
    SELECT array_agg(datname ORDER BY datname)
    FROM pg_database
    WHERE datallowconn
      AND has_database_privilege('projection_app', datname, 'CONNECT')
  ) = ARRAY['impromptu_projection']::name[],
  'projection_app must connect only to the projection database'
);
SELECT pg_temp.assert_true(
  (
    SELECT array_agg(datname ORDER BY datname)
    FROM pg_database
    WHERE datallowconn
      AND has_database_privilege('private_app', datname, 'CONNECT')
  ) = ARRAY['impromptu_private', 'impromptu_projection']::name[],
  'private_app must connect only to private and projection databases'
);
SELECT pg_temp.assert_true(
  (
    SELECT array_agg(datname ORDER BY datname)
    FROM pg_database
    WHERE datallowconn
      AND has_database_privilege('migration', datname, 'CONNECT')
  ) = ARRAY['impromptu_private', 'impromptu_projection']::name[],
  'migration must connect only to application databases'
);
SELECT pg_temp.assert_true(
  NOT has_database_privilege('projection_app', 'impromptu_projection', 'TEMPORARY')
    AND NOT has_database_privilege('private_app', 'impromptu_private', 'TEMPORARY')
    AND NOT has_database_privilege('private_app', 'impromptu_projection', 'TEMPORARY')
    AND NOT has_database_privilege('migration', 'impromptu_private', 'TEMPORARY')
    AND NOT has_database_privilege('migration', 'impromptu_projection', 'TEMPORARY'),
  'application roles must not create temporary objects'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 2
    FROM _migrations.applied_migrations
    WHERE migration_name IN ('0001_cluster.sql', '0002_restrict_template_databases.sql')
      AND checksum ~ '^[0-9a-f]{64}$'
  ),
  'cluster migration must be recorded with a checksum'
);

SELECT 'cluster privilege assertions passed' AS result;
