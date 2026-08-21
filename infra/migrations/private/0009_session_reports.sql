SET ROLE impromptu_owner;

CREATE FUNCTION private_app.report_aggregate_has_forbidden_key(value jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
  WITH RECURSIVE nodes(value) AS (
    SELECT value
    UNION ALL
    SELECT child.value
    FROM nodes
    CROSS JOIN LATERAL (
      SELECT entry.value
      FROM jsonb_each(nodes.value) AS entry
      WHERE jsonb_typeof(nodes.value) = 'object'
      UNION ALL
      SELECT entry.value
      FROM jsonb_array_elements(nodes.value) AS entry
      WHERE jsonb_typeof(nodes.value) = 'array'
    ) AS child
  )
  SELECT EXISTS (
    SELECT 1
    FROM nodes
    CROSS JOIN LATERAL jsonb_object_keys(nodes.value) AS key_name
    WHERE jsonb_typeof(nodes.value) = 'object'
      AND lower(key_name) IN (
        'transcript',
        'transcript_text',
        'transcripttext',
        'raw_audio',
        'rawaudio',
        'audio',
        'partial'
      )
  );
$$;

CREATE TABLE private_app.slide_visits (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  presentation_session_epoch bigint NOT NULL CHECK (presentation_session_epoch > 0),
  seq bigint NOT NULL CHECK (seq > 0),
  public_slide_key text NOT NULL CHECK (length(public_slide_key) BETWEEN 1 AND 512),
  occurrence_seq bigint NOT NULL CHECK (occurrence_seq > 0),
  entered_offset_ms bigint NOT NULL CHECK (entered_offset_ms >= 0),
  left_offset_ms bigint NOT NULL CHECK (left_offset_ms >= entered_offset_ms),
  producer_id text NOT NULL CHECK (length(producer_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, session_id, seq),
  UNIQUE (tenant_id, session_id, producer_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES private_app.presentation_sessions(tenant_id, session_id) ON DELETE CASCADE
);

CREATE INDEX slide_visits_session_order_idx
  ON private_app.slide_visits (tenant_id, session_id, seq);

CREATE TABLE private_app.session_report_state (
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  owner_subject text NOT NULL CHECK (length(owner_subject) BETWEEN 1 AND 512),
  revision bigint NOT NULL CHECK (revision > 0),
  speech_summary text NOT NULL CHECK (length(speech_summary) <= 4000),
  word_count integer NOT NULL CHECK (word_count >= 0),
  speaking_duration_ms bigint NOT NULL CHECK (speaking_duration_ms >= 0),
  coaching_aggregate jsonb NOT NULL CHECK (
    jsonb_typeof(coaching_aggregate) = 'object'
    AND length(coaching_aggregate::text) <= 16384
    AND NOT private_app.report_aggregate_has_forbidden_key(coaching_aggregate)
  ),
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES private_app.presentation_sessions(tenant_id, session_id) ON DELETE CASCADE
);

CREATE FUNCTION private_app.reject_finalized_session_report_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL THEN
    RAISE EXCEPTION 'session report state is finalized'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_report_state_immutable_after_finalization
  BEFORE UPDATE ON private_app.session_report_state
  FOR EACH ROW
  EXECUTE FUNCTION private_app.reject_finalized_session_report_update();

ALTER TABLE private_app.slide_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.slide_visits FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.slide_visits
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY owner_retention ON private_app.slide_visits
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);

ALTER TABLE private_app.session_report_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_app.session_report_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_app.session_report_state
  AS PERMISSIVE FOR ALL TO private_app
  USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))
  WITH CHECK (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''));
CREATE POLICY owner_retention ON private_app.session_report_state
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);

REVOKE ALL PRIVILEGES ON TABLE private_app.slide_visits FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE private_app.session_report_state FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE private_app.slide_visits TO private_app;
GRANT SELECT, INSERT, UPDATE ON TABLE private_app.session_report_state TO private_app;
REVOKE ALL PRIVILEGES ON FUNCTION private_app.report_aggregate_has_forbidden_key(jsonb) FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION private_app.reject_finalized_session_report_update() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private_app.report_aggregate_has_forbidden_key(jsonb) TO private_app;
