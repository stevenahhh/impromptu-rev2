SET ROLE impromptu_owner;

CREATE TABLE private_app.interruption_probe (
  probe_id integer PRIMARY KEY
);

RESET ROLE;
SELECT pg_catalog.pg_terminate_backend(pg_catalog.pg_backend_pid());
