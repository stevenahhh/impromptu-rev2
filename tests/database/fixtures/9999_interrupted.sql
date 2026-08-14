SET ROLE impromptu_owner;

CREATE TABLE private_app.interruption_probe (
  probe_id integer PRIMARY KEY
);

SELECT 1 / 0;
