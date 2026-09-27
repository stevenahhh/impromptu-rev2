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
INSERT INTO private_app.deck_retrieval_chunks (
  tenant_id,
  object_id,
  source_id,
  source_revision,
  source_hash,
  deck_version,
  manifest_hash,
  title,
  anchor,
  content,
  embedding,
  authorization_version
)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  'tenant-a-retrieval-chunk',
  'slide-a',
  repeat('a', 64),
  repeat('b', 64),
  'deck-tenant-a',
  repeat('c', 64),
  'Tenant A retrieval',
  'slide=1&chunk=1',
  'alpha retrieval canary',
  array_fill(0.1::double precision, ARRAY[768]),
  'acl-1'
);

-- Accounts are an authentication boundary without tenant scoping; the grant rows below
-- reference them via the account-id foreign keys on team_question_grants/team_questions.
INSERT INTO private_app.accounts (account_id, username, password_hash, created_at)
VALUES
  ('account_seed_owner_a', 'seed-owner-a', 'seed-hash-not-a-credential', transaction_timestamp()),
  ('account_seed_owner_b', 'seed-owner-b', 'seed-hash-not-a-credential', transaction_timestamp()),
  ('account_seed_teammate_b', 'seed-teammate-b', 'seed-hash-not-a-credential', transaction_timestamp()),
  ('account_seed_teammate_c', 'seed-teammate-c', 'seed-hash-not-a-credential', transaction_timestamp());

-- Tenant A grant: teammate B holds a question-only capability on A's session; one recorded
-- question exercises the inbox read path.
INSERT INTO private_app.team_question_grants (
  tenant_id,
  session_id,
  grant_id,
  owner_account_id,
  teammate_account_id,
  teammate_username,
  invitation_digest,
  idempotency_key,
  expires_at,
  accepted_at
)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'tqg_' || repeat('0', 32),
  'account_seed_owner_a',
  'account_seed_teammate_b',
  'seed-teammate-b',
  repeat('9', 64),
  'seed-issue-a-b',
  transaction_timestamp() + interval '1 hour',
  transaction_timestamp()
);
INSERT INTO private_app.team_questions (
  tenant_id,
  session_id,
  question_id,
  grant_id,
  submitted_by_account_id,
  question,
  idempotency_key
)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'tqq_' || repeat('1', 32),
  'tqg_' || repeat('0', 32),
  'account_seed_teammate_b',
  'seeded tenant-A question',
  'seed-q-a-1'
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
INSERT INTO private_app.deck_retrieval_chunks (
  tenant_id,
  object_id,
  source_id,
  source_revision,
  source_hash,
  deck_version,
  manifest_hash,
  title,
  anchor,
  content,
  embedding,
  authorization_version
)
VALUES (
  '20000000-0000-4000-8000-000000000002',
  'tenant-b-retrieval-chunk',
  'slide-b',
  repeat('d', 64),
  repeat('e', 64),
  'deck-tenant-b',
  repeat('f', 64),
  'Tenant B retrieval',
  'slide=1&chunk=1',
  'beta retrieval canary',
  array_fill(0.2::double precision, ARRAY[768]),
  'acl-1'
);

-- Tenant B grant targeted at teammate C, so the teammate-scoped read policy has one row
-- per teammate across two tenants to distinguish.
INSERT INTO private_app.team_question_grants (
  tenant_id,
  session_id,
  grant_id,
  owner_account_id,
  teammate_account_id,
  teammate_username,
  invitation_digest,
  idempotency_key,
  expires_at
)
VALUES (
  '20000000-0000-4000-8000-000000000002',
  '44444444-4444-4444-8444-444444444444',
  'tqg_' || repeat('2', 32),
  'account_seed_owner_b',
  'account_seed_teammate_c',
  'seed-teammate-c',
  repeat('8', 64),
  'seed-issue-b-c',
  transaction_timestamp() + interval '1 hour'
);
COMMIT;
