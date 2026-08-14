\set ON_ERROR_STOP 1

SELECT (current_user = 'projection_app')::integer AS correct_runtime_role \gset
\if :correct_runtime_role
\else
  \echo 'projection test did not connect as projection_app'
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

SELECT (count(*) = 1)::integer AS card_visible
FROM public_projection.published_audience_cards
WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  AND title = 'Public evidence'
  AND body = 'Audience-safe body'
  AND expires_at = '2026-08-14T05:00:00Z'::timestamptz \gset
\if :card_visible
\else
  \echo 'projection_app could not read the closed audience card view'
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

SELECT 'projection_app permitted surface passed' AS result;
