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
  'the four database roles must exist without administrative capabilities'
);

SELECT pg_temp.assert_true(
  (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname = 'impromptu_owner'),
  'the object owner must not be able to log in'
);

SELECT pg_temp.assert_true(
  (
    SELECT bool_and(rolcanlogin AND NOT rolinherit)
    FROM pg_roles
    WHERE rolname IN ('migration', 'private_app', 'projection_app')
  ),
  'migration and runtime roles must be direct, non-inheriting login roles'
);

SELECT pg_temp.assert_true(
  NOT has_schema_privilege('projection_app', 'private_app', 'USAGE'),
  'projection_app must not have USAGE on private_app'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'projection_app',
    'private_app.presentation_sessions',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'projection_app must have no private table privileges'
);
SELECT pg_temp.assert_true(
  NOT has_table_privilege(
    'projection_app',
    'public_projection.projection_sessions',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'projection_app must not access projection base tables'
);
SELECT pg_temp.assert_true(
  has_table_privilege('projection_app', 'public_projection.current_projection', 'SELECT')
    AND has_table_privilege(
      'projection_app',
      'public_projection.published_audience_cards',
      'SELECT'
    ),
  'projection_app must read only the public views'
);
SELECT pg_temp.assert_true(
  has_function_privilege(
    'projection_app',
    'public_projection.record_display_receipt(uuid,uuid,bigint,uuid,text,public_projection.receipt_status)',
    'EXECUTE'
  ),
  'projection_app must execute the narrow receipt function'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_database AS database
    CROSS JOIN LATERAL aclexplode(
      coalesce(database.datacl, acldefault('d', database.datdba))
    ) AS privilege
    WHERE database.datname = current_database()
      AND privilege.grantee = 0
      AND privilege.privilege_type IN ('CONNECT', 'TEMPORARY')
  ),
  'PUBLIC must have no database privileges'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) AS privilege
    WHERE namespace.nspname IN ('public', 'private_app', 'public_projection')
      AND privilege.grantee = 0
      AND privilege.privilege_type IN ('USAGE', 'CREATE')
  ),
  'PUBLIC must have no schema privileges'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_type AS type
    JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(type.typacl, acldefault('T', type.typowner))
    ) AS privilege
    WHERE namespace.nspname IN ('private_app', 'public_projection')
      AND type.typtype IN ('d', 'e')
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'USAGE'
  ),
  'PUBLIC must not use application enum or domain types'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) AS privilege
    WHERE namespace.nspname = 'public_projection'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC must not execute public_projection functions'
);

SET ROLE impromptu_owner;
CREATE FUNCTION public_projection.default_acl_probe()
RETURNS integer
LANGUAGE sql
AS 'SELECT 1';
RESET ROLE;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    CROSS JOIN LATERAL aclexplode(
      coalesce(procedure.proacl, acldefault('f', procedure.proowner))
    ) AS privilege
    WHERE procedure.oid = 'public_projection.default_acl_probe()'::regprocedure
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ),
  'new owner functions must not grant PUBLIC execute by default'
);

SET ROLE impromptu_owner;
DROP FUNCTION public_projection.default_acl_probe();
RESET ROLE;

SELECT pg_temp.assert_true(
  NOT EXISTS (
    WITH expected(table_name, column_name, data_type, udt_name) AS (
      VALUES
        ('projection_sessions', 'projection_id', 'uuid', 'uuid'),
        ('projection_sessions', 'presentation_session_epoch', 'bigint', 'int8'),
        ('projection_sessions', 'display_binding_epoch', 'bigint', 'int8'),
        ('projection_sessions', 'manifest_hash', 'text', 'text'),
        ('projection_sessions', 'state', 'USER-DEFINED', 'projection_state'),
        ('audience_cards', 'card_id', 'uuid', 'uuid'),
        ('audience_cards', 'basis_date', 'date', 'date'),
        ('audience_cards', 'published_at', 'timestamp with time zone', 'timestamptz'),
        ('audience_cards', 'expires_at', 'timestamp with time zone', 'timestamptz'),
        ('display_receipts', 'status', 'USER-DEFINED', 'receipt_status'),
        ('display_receipts', 'received_at', 'timestamp with time zone', 'timestamptz')
    )
    SELECT * FROM expected
    EXCEPT
    SELECT table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public_projection'
  ),
  'public projection storage must use the declared PostgreSQL types'
);

SELECT pg_temp.assert_true(
  NOT EXISTS (
    SELECT 1
    FROM public_projection.current_projection
    CROSS JOIN public_projection.published_audience_cards
    WHERE current_projection::text LIKE '%PRIVATE_CANARY%'
       OR published_audience_cards::text LIKE '%PRIVATE_CANARY%'
  ),
  'public views must not expose seeded private canaries'
);

SELECT 'database catalog assertions passed' AS result;
