\set ON_ERROR_STOP 1

SELECT (
  current_database() = 'impromptu_projection'
  AND current_user = 'projection_app'
)::integer AS correct_runtime_role \gset
\if :correct_runtime_role
\else
  \echo 'projection test used the wrong database role or database'
  \quit 1
\endif

SELECT (count(*) = 1)::integer AS projection_visible
FROM public_projection.current_projection
WHERE projection_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  AND presentation_session_epoch = 7
  AND display_binding_epoch = 3
  AND revision = 9 \gset
\if :projection_visible
\else
  \echo 'projection_app could not read the expected projection view'
  \quit 1
\endif

SELECT (
  count(*) = 1
  AND bool_and(id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid)
  AND bool_and(title = 'Visible evidence')
)::integer AS lifecycle_filtered
FROM public_projection.published_audience_cards \gset
\if :lifecycle_filtered
\else
  \echo 'audience card lifecycle filtering exposed a non-public card'
  \quit 1
\endif

SELECT (
  to_regnamespace('private_app') IS NULL
  AND to_regclass('private_app.presentation_sessions') IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class
    WHERE relname IN ('presentation_sessions', 'evidence_candidates', 'publication_outbox')
  )
)::integer AS private_catalog_absent \gset
\if :private_catalog_absent
\else
  \echo 'projection_app observed private structural metadata'
  \quit 1
\endif

SELECT bool_and(
  NOT has_function_privilege(current_user, signature, 'EXECUTE')
)::integer AS large_object_mutation_denied
FROM unnest(ARRAY[
  'pg_catalog.lo_create(oid)',
  'pg_catalog.lo_creat(integer)',
  'pg_catalog.lo_from_bytea(oid,bytea)',
  'pg_catalog.lo_put(oid,bigint,bytea)',
  'pg_catalog.lo_unlink(oid)',
  'pg_catalog.lowrite(integer,bytea)',
  'pg_catalog.lo_truncate(integer,integer)',
  'pg_catalog.lo_truncate64(integer,bigint)',
  'pg_catalog.lo_import(text)',
  'pg_catalog.lo_import(text,oid)'
]) AS functions(signature) \gset
\if :large_object_mutation_denied
\else
  \echo 'projection_app retained execution on a large-object mutation function'
  \quit 1
\endif

SELECT (count(*) = 1)::integer AS receipt_recorded
FROM public_projection.record_display_receipt(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  1,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  repeat('b', 64),
  'stage_applied'
) \gset
\if :receipt_recorded
\else
  \echo 'projection_app could not call the narrow receipt function'
  \quit 1
\endif

SELECT (count(*) = 1)::integer AS duplicate_receipt_is_idempotent
FROM public_projection.record_display_receipt(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  1,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  repeat('b', 64),
  'stage_applied'
) \gset
\if :duplicate_receipt_is_idempotent
\else
  \echo 'an identical receipt retry was not idempotent'
  \quit 1
\endif

SELECT (count(*) = 0)::integer AS conflicting_receipt_rejected
FROM public_projection.record_display_receipt(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  1,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  repeat('d', 64),
  'stage_applied'
) \gset
\if :conflicting_receipt_rejected
\else
  \echo 'a conflicting receipt retry overwrote the accepted receipt'
  \quit 1
\endif

SELECT (
  count(*) = 1
  AND bool_and(revision = 1)
  AND bool_and(snapshot ->> 'stateKind' = 'PREPARED_EVIDENCE_PROJECTION_DATABASE_SNAPSHOT')
)::integer AS gateway_state_visible
FROM public_projection.read_gateway_state('database-test') \gset
\if :gateway_state_visible
\else
  \echo 'projection_app could not read gateway state through the narrow function'
  \quit 1
\endif

SELECT 'projection_app permitted surface passed' AS result;
