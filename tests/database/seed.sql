\set ON_ERROR_STOP 1

INSERT INTO private_app.presentation_sessions (
  session_id,
  owner_subject,
  presentation_session_epoch,
  deck_storage_uri,
  presenter_notes
)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'account:private-owner',
  7,
  'private-decks/tenant-a/deck.pptx',
  'PRIVATE_CANARY_DO_NOT_PROJECT'
);

INSERT INTO private_app.evidence_candidates (
  candidate_id,
  session_id,
  candidate_version,
  raw_excerpt,
  internal_source_uri,
  classification
)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  1,
  'PRIVATE_CANARY_RAW_EXCERPT',
  's3://private-decks/tenant-a/source.pdf',
  'private'
);

INSERT INTO public_projection.projection_sessions (
  projection_id,
  presentation_session_epoch,
  display_binding_epoch,
  deck_version,
  manifest_hash,
  current_slide_key,
  occurrence_seq,
  state,
  revision
)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  7,
  3,
  4,
  repeat('a', 64),
  'slide-public-2',
  1,
  'active',
  9
);

INSERT INTO public_projection.audience_cards (
  projection_id,
  card_id,
  card_version,
  public_slide_key,
  occurrence_seq,
  title,
  body,
  source_label,
  canonical_url,
  published_at,
  basis_date,
  approved_asset_hash,
  attribution,
  alt_text,
  expires_at,
  revision
)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  2,
  'slide-public-2',
  1,
  'Public evidence',
  'Audience-safe body',
  'Public source',
  'https://example.test/source',
  '2026-08-14T04:00:00Z',
  '2026-08-01',
  repeat('c', 64),
  'Example attribution',
  'Audience-safe alternative text',
  '2026-08-14T05:00:00Z',
  10
);
