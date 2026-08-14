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
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '33333333-3333-4333-8333-333333333333',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'publish_card',
  '{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","title":"Public evidence"}'::jsonb
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
