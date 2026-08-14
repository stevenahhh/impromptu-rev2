SET ROLE impromptu_owner;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA private_app AUTHORIZATION impromptu_owner;
REVOKE ALL PRIVILEGES ON SCHEMA private_app FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner
  REVOKE ALL PRIVILEGES ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner
  REVOKE ALL PRIVILEGES ON TYPES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner IN SCHEMA private_app
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE impromptu_owner IN SCHEMA private_app
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;

CREATE TYPE private_app.candidate_classification AS ENUM (
  'private',
  'eligible_for_review',
  'rejected'
);
CREATE TYPE private_app.publication_event_kind AS ENUM (
  'upsert_projection',
  'publish_card',
  'retract_card',
  'end_projection'
);

CREATE TABLE private_app.tenants (
  tenant_id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE private_app.presentation_sessions (
  tenant_id uuid NOT NULL REFERENCES private_app.tenants(tenant_id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  owner_subject text NOT NULL CHECK (length(owner_subject) BETWEEN 1 AND 512),
  presentation_session_epoch bigint NOT NULL CHECK (presentation_session_epoch > 0),
  deck_storage_uri text NOT NULL CHECK (length(deck_storage_uri) BETWEEN 1 AND 2048),
  presenter_notes text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  ended_at timestamptz,
  PRIMARY KEY (tenant_id, session_id),
  CHECK (ended_at IS NULL OR ended_at >= created_at)
);

CREATE TABLE private_app.evidence_candidates (
  tenant_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  session_id uuid NOT NULL,
  candidate_version bigint NOT NULL CHECK (candidate_version > 0),
  raw_excerpt text NOT NULL CHECK (length(raw_excerpt) > 0),
  internal_source_uri text NOT NULL CHECK (length(internal_source_uri) BETWEEN 1 AND 2048),
  classification private_app.candidate_classification NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, candidate_id, candidate_version),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES private_app.presentation_sessions(tenant_id, session_id) ON DELETE CASCADE
);

CREATE TABLE private_app.publication_outbox (
  tenant_id uuid NOT NULL REFERENCES private_app.tenants(tenant_id) ON DELETE CASCADE,
  outbox_id uuid NOT NULL,
  projection_id uuid NOT NULL,
  event_kind private_app.publication_event_kind NOT NULL,
  public_payload jsonb NOT NULL CHECK (jsonb_typeof(public_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  PRIMARY KEY (tenant_id, outbox_id),
  CHECK (delivered_at IS NULL OR delivered_at >= created_at)
);

ALTER TABLE private_app.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.tenants
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE private_app.presentation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.presentation_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.presentation_sessions
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE private_app.evidence_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.evidence_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.evidence_candidates
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE private_app.publication_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.publication_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.publication_outbox
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT USAGE ON SCHEMA private_app TO private_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA private_app TO private_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA private_app TO private_app;
GRANT USAGE ON TYPE private_app.candidate_classification TO private_app;
GRANT USAGE ON TYPE private_app.publication_event_kind TO private_app;
