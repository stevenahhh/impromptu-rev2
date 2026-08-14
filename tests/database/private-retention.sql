\set ON_ERROR_STOP 1

SELECT (
  current_database() = 'impromptu_private'
  AND current_user = 'retention_worker'
)::integer AS correct_runtime_role \gset
\if :correct_runtime_role
\else
  \echo 'private retention test used the wrong database role or database'
  SELECT 1 / 0;
\endif

SELECT * FROM private_app.apply_retention(
  '10000000-0000-4000-8000-000000000001',
  'infinity'::timestamptz
) \gset

SELECT (
  :deleted_presentations = 1
  AND :deleted_candidates = 1
  AND :deleted_outbox_events = 2
)::integer AS exact_private_cascade \gset
\if :exact_private_cascade
\else
  \echo 'private retention cascade returned unexpected deletion counts'
  SELECT 1 / 0;
\endif
