\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'impromptu_owner') THEN
    CREATE ROLE impromptu_owner;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migration') THEN
    CREATE ROLE migration;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'private_app') THEN
    CREATE ROLE private_app;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projection_app') THEN
    CREATE ROLE projection_app;
  END IF;
END;
$$;

ALTER ROLE impromptu_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE migration
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE private_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE projection_app
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT impromptu_owner TO migration;

SELECT 'CREATE DATABASE impromptu_private OWNER impromptu_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'impromptu_private')
\gexec
SELECT 'CREATE DATABASE impromptu_projection OWNER impromptu_owner'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'impromptu_projection')
\gexec

REVOKE ALL PRIVILEGES ON DATABASE postgres FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE postgres FROM migration, private_app, projection_app;
GRANT CREATE ON DATABASE postgres TO impromptu_owner;

REVOKE ALL PRIVILEGES ON DATABASE impromptu_private FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE impromptu_private FROM migration, private_app, projection_app;
GRANT CONNECT ON DATABASE impromptu_private TO migration, private_app;

REVOKE ALL PRIVILEGES ON DATABASE impromptu_projection FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE impromptu_projection FROM migration, private_app, projection_app;
GRANT CONNECT ON DATABASE impromptu_projection TO migration, private_app, projection_app;

ALTER ROLE migration IN DATABASE impromptu_private SET search_path = pg_catalog;
ALTER ROLE migration IN DATABASE impromptu_projection SET search_path = pg_catalog;
ALTER ROLE private_app IN DATABASE impromptu_private
  SET search_path = private_app, pg_catalog;
ALTER ROLE private_app IN DATABASE impromptu_projection
  SET search_path = public_projection, pg_catalog;
ALTER ROLE projection_app IN DATABASE impromptu_projection
  SET search_path = public_projection, pg_catalog;

\connect impromptu_private impromptu_bootstrap
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_put(oid, bigint, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_unlink(oid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lowrite(integer, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_truncate(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_truncate64(integer, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text, oid) FROM PUBLIC;

\connect impromptu_projection impromptu_bootstrap
REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_creat(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_from_bytea(oid, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_put(oid, bigint, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_unlink(oid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lowrite(integer, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_truncate(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_truncate64(integer, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION pg_catalog.lo_import(text, oid) FROM PUBLIC;
