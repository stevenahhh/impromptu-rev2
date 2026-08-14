\set ON_ERROR_STOP 1

SELECT (
  current_database() = 'impromptu_projection'
  AND current_user = 'publication_dispatcher'
)::integer AS correct_runtime_role \gset
\if :correct_runtime_role
\else
  \echo 'dispatcher test used the wrong database role or database'
  \quit 1
\endif

SELECT (
  public_projection.dispatch_publication(
    '70000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'publish_card',
    '{"title":"Inbox publication"}'::jsonb
  ) = 'APPLIED'
)::integer AS first_dispatch_applied \gset
\if :first_dispatch_applied
\else
  \echo 'first projection dispatch was not applied'
  \quit 1
\endif

SELECT (
  public_projection.dispatch_publication(
    '70000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'publish_card',
    '{"title":"Inbox publication"}'::jsonb
  ) = 'DUPLICATE'
)::integer AS replay_is_duplicate \gset
\if :replay_is_duplicate
\else
  \echo 'projection replay was not deduplicated'
  \quit 1
\endif

SELECT 'projection dispatcher permitted surface passed' AS result;
