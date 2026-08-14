SET ROLE impromptu_owner;

CREATE POLICY owner_retention ON private_app.presentation_sessions
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_retention ON private_app.evidence_candidates
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_retention ON private_app.publication_outbox
  AS PERMISSIVE FOR ALL TO impromptu_owner USING (true) WITH CHECK (true);

CREATE FUNCTION private_app.apply_retention(
  requested_tenant_id uuid,
  retained_before timestamptz
)
RETURNS TABLE (
  deleted_presentations bigint,
  deleted_candidates bigint,
  deleted_outbox_events bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, private_app
AS $$
DECLARE
  candidate_count bigint;
  presentation_count bigint;
  outbox_count bigint;
BEGIN
  IF requested_tenant_id IS NULL OR retained_before IS NULL THEN
    RAISE EXCEPTION 'tenant and retention cutoff are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT count(*) INTO candidate_count
  FROM private_app.evidence_candidates AS candidate
  JOIN private_app.presentation_sessions AS presentation
    ON presentation.tenant_id = candidate.tenant_id
   AND presentation.session_id = candidate.session_id
  WHERE presentation.tenant_id = requested_tenant_id
    AND presentation.created_at < retained_before;

  DELETE FROM private_app.presentation_sessions
  WHERE tenant_id = requested_tenant_id
    AND created_at < retained_before;
  GET DIAGNOSTICS presentation_count = ROW_COUNT;

  DELETE FROM private_app.publication_outbox
  WHERE tenant_id = requested_tenant_id
    AND created_at < retained_before;
  GET DIAGNOSTICS outbox_count = ROW_COUNT;

  RETURN QUERY SELECT presentation_count, candidate_count, outbox_count;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION private_app.apply_retention(uuid, timestamptz) FROM PUBLIC;
GRANT USAGE ON SCHEMA private_app TO retention_worker;
GRANT EXECUTE ON FUNCTION private_app.apply_retention(uuid, timestamptz) TO retention_worker;
