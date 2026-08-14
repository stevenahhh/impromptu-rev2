\set ON_ERROR_STOP 1

BEGIN;
SET LOCAL app.tenant_id = '10000000-0000-4000-8000-000000000001';
INSERT INTO private_app.tenants (tenant_id, display_name)
VALUES ('10000000-0000-4000-8000-000000000001', 'Tenant A');
INSERT INTO private_app.presentation_sessions (
  tenant_id,
  session_id,
  owner_subject,
  presentation_session_epoch,
  deck_storage_uri,
  presenter_notes
)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'account:tenant-a-owner',
  7,
  'private-decks/tenant-a/deck.pptx',
  'PRIVATE_CANARY_TENANT_A'
);
INSERT INTO private_app.evidence_candidates (
  tenant_id,
  candidate_id,
  session_id,
  candidate_version,
  raw_excerpt,
  internal_source_uri,
  classification
)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  1,
  'PRIVATE_CANARY_RAW_EXCERPT_A',
  's3://private-decks/tenant-a/source.pdf',
  'private'
);
INSERT INTO private_app.publication_outbox (
  tenant_id,
  outbox_id,
  projection_id,
  event_kind,
  public_payload
)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333333',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'publish_card',
    '{
      "cardId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cardVersion":1,
      "publicSlideKey":"slide-public-2",
      "occurrenceSeq":1,
      "title":"Public evidence one",
      "body":"Audience-safe body one",
      "sourceLabel":"Public source",
      "canonicalUrl":"https://example.test/evidence/one",
      "publishedAt":"2026-08-14T08:00:00Z",
      "expiresAt":"2026-08-14T09:00:00Z",
      "revision":10
    }'::jsonb
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '33333333-3333-4333-8333-333333333334',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'publish_card',
    '{
      "cardId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
      "cardVersion":1,
      "publicSlideKey":"slide-public-2",
      "occurrenceSeq":1,
      "title":"Public evidence two",
      "body":"Audience-safe body two",
      "sourceLabel":"Public source",
      "canonicalUrl":"https://example.test/evidence/two",
      "publishedAt":"2026-08-14T08:00:00Z",
      "expiresAt":"2026-08-14T09:00:00Z",
      "revision":11
    }'::jsonb
  );
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '20000000-0000-4000-8000-000000000002';
INSERT INTO private_app.tenants (tenant_id, display_name)
VALUES ('20000000-0000-4000-8000-000000000002', 'Tenant B');
INSERT INTO private_app.presentation_sessions (
  tenant_id,
  session_id,
  owner_subject,
  presentation_session_epoch,
  deck_storage_uri,
  presenter_notes
)
VALUES (
  '20000000-0000-4000-8000-000000000002',
  '44444444-4444-4444-8444-444444444444',
  'account:tenant-b-owner',
  3,
  'private-decks/tenant-b/deck.pptx',
  'PRIVATE_CANARY_TENANT_B'
);
COMMIT;
