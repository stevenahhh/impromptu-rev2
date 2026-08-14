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
  NOT has_database_privilege('projection_app', 'postgres', 'CONNECT,TEMPORARY')
    AND NOT has_database_privilege('projection_app', 'impromptu_private', 'CONNECT,TEMPORARY')
    AND has_database_privilege('projection_app', 'impromptu_projection', 'CONNECT')
    AND NOT has_database_privilege('projection_app', 'impromptu_projection', 'TEMPORARY'),
  'projection_app must connect only to projection without temporary-object access'
);
SELECT pg_temp.assert_true(
  NOT has_database_privilege('private_app', 'postgres', 'CONNECT,TEMPORARY')
    AND has_database_privilege('private_app', 'impromptu_private', 'CONNECT')
    AND NOT has_database_privilege('private_app', 'impromptu_private', 'TEMPORARY')
    AND has_database_privilege('private_app', 'impromptu_projection', 'CONNECT')
    AND NOT has_database_privilege('private_app', 'impromptu_projection', 'TEMPORARY'),
  'private_app must connect only to private and projection databases'
);
SELECT pg_temp.assert_true(
  NOT has_database_privilege('migration', 'postgres', 'CONNECT,TEMPORARY')
    AND has_database_privilege('migration', 'impromptu_private', 'CONNECT')
    AND has_database_privilege('migration', 'impromptu_projection', 'CONNECT')
    AND NOT has_database_privilege('migration', 'impromptu_private', 'TEMPORARY')
    AND NOT has_database_privilege('migration', 'impromptu_projection', 'TEMPORARY'),
  'migration must connect only to application databases'
);
SELECT pg_temp.assert_true(
  (
    SELECT count(*) = 1
    FROM _migrations.applied_migrations
    WHERE migration_name = '0001_cluster.sql'
      AND checksum ~ '^[0-9a-f]{64}$'
  ),
  'cluster migration must be recorded with a checksum'
);

SELECT 'cluster privilege assertions passed' AS result;
