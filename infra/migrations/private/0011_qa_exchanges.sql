SET ROLE impromptu_owner;

-- Persisted Q&A defense exchanges for one presentation session, in ask order
-- (`ask_seq`, an identity assigned at insert). The mapped model outcome is a closed
-- discriminated payload in `defense_payload`; fail-closed appending after report
-- finalization is enforced by the repository against `session_report_state`.
CREATE TABLE private_app.qa_exchanges (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  exchange_id text NOT NULL CHECK (length(exchange_id) BETWEEN 1 AND 200),
  ask_seq bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  asked_offset_ms bigint NOT NULL CHECK (asked_offset_ms >= 0),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 4000),
  origin text NOT NULL CHECK (origin IN ('TYPED', 'SPOKEN')),
  defense_payload jsonb NOT NULL CHECK (
    jsonb_typeof(defense_payload) = 'object'
    AND length(defense_payload::text) <= 16384
    AND defense_payload ->> 'outcome' IN ('ANSWERED', 'ABSTAINED')
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, session_id, exchange_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES private_app.presentation_sessions(tenant_id, session_id) ON DELETE CASCADE
);

CREATE INDEX qa_exchanges_session_ask_idx
  ON private_app.qa_exchanges (tenant_id, session_id, ask_seq);

-- Report DTO contract generation: existing rows are v1; v2 code stamps 2 exactly when
-- a finalize CAS lands, so old finalized reports read back without the qaDefense section.
ALTER TABLE private_app.session_report_state
  ADD COLUMN report_version integer NOT NULL DEFAULT 1 CHECK (report_version >= 1);

ALTER TABLE private_app.qa_exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.qa_exchanges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.qa_exchanges
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY owner_retention ON private_app.qa_exchanges
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE private_app.qa_exchanges FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE private_app.qa_exchanges TO private_app;
