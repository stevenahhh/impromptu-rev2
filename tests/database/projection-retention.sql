\set ON_ERROR_STOP 1

SELECT (
  current_database() = 'impromptu_projection'
  AND current_user = 'retention_worker'
)::integer AS correct_runtime_role \gset
\if :correct_runtime_role
\else
  \echo 'projection retention test used the wrong database role or database'
  SELECT 1 / 0;
\endif

SELECT * FROM public_projection.apply_retention(
  '10000000-0000-4000-8000-000000000001',
  'infinity'::timestamptz
) \gset

SELECT (
  :deleted_projections = 1
  AND :deleted_cards = 5
  AND :deleted_receipts = 2
  AND :deleted_publication_events = 4
)::integer AS exact_projection_cascade \gset
\if :exact_projection_cascade
\else
  \echo 'projection retention cascade returned unexpected deletion counts'
  SELECT 1 / 0;
\endif
