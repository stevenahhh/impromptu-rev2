\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retention_worker') THEN
    CREATE ROLE retention_worker;
  END IF;
END;
$$;

ALTER ROLE retention_worker
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON DATABASE postgres FROM retention_worker;
REVOKE ALL PRIVILEGES ON DATABASE impromptu_private FROM retention_worker;
REVOKE ALL PRIVILEGES ON DATABASE impromptu_projection FROM retention_worker;
GRANT CONNECT ON DATABASE impromptu_private TO retention_worker;
GRANT CONNECT ON DATABASE impromptu_projection TO retention_worker;

ALTER ROLE retention_worker IN DATABASE impromptu_private
  SET search_path = private_app, pg_catalog;
ALTER ROLE retention_worker IN DATABASE impromptu_projection
  SET search_path = public_projection, pg_catalog;
