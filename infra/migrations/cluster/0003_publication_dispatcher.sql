\set ON_ERROR_STOP 1

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publication_dispatcher') THEN
    CREATE ROLE publication_dispatcher;
  END IF;
END;
$$;

ALTER ROLE publication_dispatcher
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

REVOKE ALL PRIVILEGES ON DATABASE postgres FROM publication_dispatcher;
REVOKE ALL PRIVILEGES ON DATABASE impromptu_private FROM publication_dispatcher;
REVOKE ALL PRIVILEGES ON DATABASE impromptu_projection FROM publication_dispatcher;
GRANT CONNECT ON DATABASE impromptu_private TO publication_dispatcher;
GRANT CONNECT ON DATABASE impromptu_projection TO publication_dispatcher;

ALTER ROLE publication_dispatcher IN DATABASE impromptu_private
  SET search_path = private_app, pg_catalog;
ALTER ROLE publication_dispatcher IN DATABASE impromptu_projection
  SET search_path = public_projection, pg_catalog;
