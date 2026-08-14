\set ON_ERROR_STOP 1

INSERT INTO public_projection.projection_sessions (
  projection_id,
  tenant_id,
  presentation_session_epoch,
  display_binding_epoch,
  deck_version,
  manifest_hash,
  current_slide_key,
  occurrence_seq,
  state,
  revision
)
VALUES
(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000001',
  7,
  3,
  4,
  repeat('a', 64),
  'slide-public-2',
  1,
  'active',
  9
),
(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '20000000-0000-4000-8000-000000000002',
  3,
  1,
  1,
  repeat('d', 64),
  NULL,
  NULL,
  'bound',
  1
);

INSERT INTO public_projection.audience_cards (
  projection_id,
  card_id,
  card_version,
  public_slide_key,
  occurrence_seq,
  lifecycle,
  title,
  body,
  source_label,
  canonical_url,
  published_at,
  expires_at,
  retracted_at,
  revision
)
VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    1,
    'slide-public-2',
    1,
    'published',
    'Visible evidence',
    'Audience-safe body',
    'Public source',
    'https://example.test/visible',
    statement_timestamp() - interval '1 minute',
    statement_timestamp() + interval '1 hour',
    NULL,
    10
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
    1,
    'slide-public-2',
    1,
    'draft',
    'Draft evidence',
    'Must not be visible',
    'Public source',
    'https://example.test/draft',
    NULL,
    statement_timestamp() + interval '1 hour',
    NULL,
    11
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-000000000003',
    1,
    'slide-public-2',
    1,
    'retracted',
    'Retracted evidence',
    'Must not be visible',
    'Public source',
    'https://example.test/retracted',
    statement_timestamp() - interval '2 hours',
    statement_timestamp() + interval '1 hour',
    statement_timestamp() - interval '1 hour',
    12
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-000000000004',
    1,
    'slide-public-2',
    1,
    'published',
    'Expired evidence',
    'Must not be visible',
    'Public source',
    'https://example.test/expired',
    statement_timestamp() - interval '2 hours',
    statement_timestamp() - interval '1 hour',
    NULL,
    13
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-000000000005',
    1,
    'slide-public-2',
    1,
    'scheduled',
    'Scheduled evidence',
    'Must not be visible',
    'Public source',
    'https://example.test/scheduled',
    statement_timestamp() + interval '1 hour',
    statement_timestamp() + interval '2 hours',
    NULL,
    14
  );
