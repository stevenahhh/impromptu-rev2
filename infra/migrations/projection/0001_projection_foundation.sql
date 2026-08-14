SET ROLE impromptu_owner;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA public_projection AUTHORIZATION impromptu_owner;
REVOKE ALL PRIVILEGES ON SCHEMA public_projection FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner
  REVOKE ALL PRIVILEGES ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner IN SCHEMA public_projection
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner IN SCHEMA public_projection
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;

CREATE TYPE public_projection.projection_state AS ENUM (
  'bound',
  'active',
  'ended'
);
CREATE TYPE public_projection.card_lifecycle AS ENUM (
  'draft',
  'scheduled',
  'published',
  'retracted'
);
CREATE TYPE public_projection.receipt_status AS ENUM (
  'accepted',
  'stage_applied'
);

CREATE TABLE public_projection.projection_sessions (
  projection_id uuid PRIMARY KEY,
  presentation_session_epoch bigint NOT NULL CHECK (presentation_session_epoch > 0),
  display_binding_epoch bigint NOT NULL CHECK (display_binding_epoch > 0),
  deck_version bigint NOT NULL CHECK (deck_version > 0),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  current_slide_key text CHECK (
    current_slide_key IS NULL OR length(current_slide_key) BETWEEN 1 AND 256
  ),
  occurrence_seq bigint CHECK (occurrence_seq IS NULL OR occurrence_seq > 0),
  state public_projection.projection_state NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CHECK (
    (current_slide_key IS NULL AND occurrence_seq IS NULL)
    OR (current_slide_key IS NOT NULL AND occurrence_seq IS NOT NULL)
  ),
  CHECK (updated_at >= created_at)
);

CREATE TABLE public_projection.audience_cards (
  projection_id uuid NOT NULL
    REFERENCES public_projection.projection_sessions(projection_id) ON DELETE CASCADE,
  card_id uuid NOT NULL,
  card_version bigint NOT NULL CHECK (card_version > 0),
  public_slide_key text NOT NULL CHECK (length(public_slide_key) BETWEEN 1 AND 256),
  occurrence_seq bigint NOT NULL CHECK (occurrence_seq > 0),
  lifecycle public_projection.card_lifecycle NOT NULL DEFAULT 'draft',
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  source_label text NOT NULL CHECK (length(source_label) BETWEEN 1 AND 300),
  canonical_url text NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
  published_at timestamptz,
  basis_date date,
  approved_asset_hash text CHECK (
    approved_asset_hash IS NULL OR approved_asset_hash ~ '^[0-9a-f]{64}$'
  ),
  attribution text CHECK (attribution IS NULL OR length(attribution) <= 500),
  alt_text text CHECK (alt_text IS NULL OR length(alt_text) <= 1000),
  expires_at timestamptz NOT NULL,
  retracted_at timestamptz,
  revision bigint NOT NULL CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (projection_id, card_id, card_version),
  CONSTRAINT audience_cards_lifecycle_check CHECK (
    (lifecycle = 'draft' AND published_at IS NULL AND retracted_at IS NULL)
    OR (
      lifecycle IN ('scheduled', 'published')
      AND published_at IS NOT NULL
      AND retracted_at IS NULL
      AND expires_at > published_at
    )
    OR (
      lifecycle = 'retracted'
      AND published_at IS NOT NULL
      AND retracted_at IS NOT NULL
      AND retracted_at >= published_at
      AND expires_at > published_at
    )
  )
);

CREATE TABLE public_projection.display_receipts (
  projection_id uuid NOT NULL
    REFERENCES public_projection.projection_sessions(projection_id) ON DELETE CASCADE,
  display_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  command_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status public_projection.receipt_status NOT NULL,
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (projection_id, display_id, revision)
);

CREATE VIEW public_projection.current_projection
WITH (security_barrier = true)
AS
SELECT
  projection_id,
  presentation_session_epoch,
  display_binding_epoch,
  deck_version,
  manifest_hash,
  current_slide_key,
  occurrence_seq,
  state,
  revision,
  updated_at
FROM public_projection.projection_sessions;

CREATE VIEW public_projection.published_audience_cards
WITH (security_barrier = true)
AS
SELECT
  projection_id,
  card_id AS id,
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
FROM public_projection.audience_cards
WHERE lifecycle = 'published'
  AND published_at <= statement_timestamp()
  AND retracted_at IS NULL
  AND expires_at > statement_timestamp();

CREATE FUNCTION public_projection.record_display_receipt(
  requested_projection_id uuid,
  requested_display_id uuid,
  requested_revision bigint,
  requested_command_id uuid,
  requested_request_hash text,
  requested_status public_projection.receipt_status
)
RETURNS TABLE (
  projection_id uuid,
  display_id uuid,
  revision bigint,
  status public_projection.receipt_status,
  received_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public_projection
AS $$
  INSERT INTO public_projection.display_receipts AS existing (
    projection_id,
    display_id,
    revision,
    command_id,
    request_hash,
    status
  )
  VALUES (
    requested_projection_id,
    requested_display_id,
    requested_revision,
    requested_command_id,
    requested_request_hash,
    requested_status
  )
  ON CONFLICT (projection_id, display_id, revision) DO UPDATE
  SET received_at = existing.received_at
  WHERE existing.command_id = excluded.command_id
    AND existing.request_hash = excluded.request_hash
    AND existing.status = excluded.status
  RETURNING
    existing.projection_id,
    existing.display_id,
    existing.revision,
    existing.status,
    existing.received_at;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public_projection.record_display_receipt(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  public_projection.receipt_status
) FROM PUBLIC;

GRANT USAGE ON SCHEMA public_projection TO private_app, projection_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public_projection TO private_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public_projection TO private_app;
GRANT USAGE ON TYPE public_projection.projection_state TO private_app, projection_app;
GRANT USAGE ON TYPE public_projection.card_lifecycle TO private_app, projection_app;
GRANT USAGE ON TYPE public_projection.receipt_status TO private_app, projection_app;

REVOKE ALL PRIVILEGES ON TABLE public_projection.projection_sessions FROM projection_app;
REVOKE ALL PRIVILEGES ON TABLE public_projection.audience_cards FROM projection_app;
REVOKE ALL PRIVILEGES ON TABLE public_projection.display_receipts FROM projection_app;
GRANT SELECT ON public_projection.current_projection TO projection_app;
GRANT SELECT ON public_projection.published_audience_cards TO projection_app;
GRANT EXECUTE ON FUNCTION public_projection.record_display_receipt(
  uuid,
  uuid,
  bigint,
  uuid,
  text,
  public_projection.receipt_status
) TO projection_app;
