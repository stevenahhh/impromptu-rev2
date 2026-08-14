\set ON_ERROR_STOP 1

REVOKE ALL PRIVILEGES ON DATABASE impromptu_projection FROM private_app;
ALTER ROLE private_app IN DATABASE impromptu_projection SET search_path = pg_catalog;
