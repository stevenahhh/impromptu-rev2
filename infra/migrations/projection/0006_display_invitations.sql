SET ROLE impromptu_owner;

-- Separately versioned, one-per-deployment state row for one-use display invitations.
-- Lives beside (not inside) public_projection.gateway_state so the previous gateway binary
-- keeps restoring its closed snapshot; only token digests are ever persisted.
CREATE TABLE public_projection.display_invitation_state (
  state_key text PRIMARY KEY CHECK (length(state_key) BETWEEN 1 AND 200),
  revision bigint NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(snapshot) = 'object'
    AND snapshot ->> 'stateKind' = 'DISPLAY_INVITATION_STATE_SNAPSHOT'
  ),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

ALTER TABLE public_projection.display_invitation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_projection.display_invitation_state FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_internal ON public_projection.display_invitation_state
  AS PERMISSIVE FOR ALL TO impromptu_owner
  USING (true)
  WITH CHECK (true);

CREATE FUNCTION public_projection.read_invitation_state(requested_state_key text)
RETURNS TABLE (revision bigint, snapshot jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public_projection
AS $$
  SELECT state.revision, state.snapshot
  FROM public_projection.display_invitation_state AS state
  WHERE state.state_key = requested_state_key;
$$;

CREATE FUNCTION public_projection.write_invitation_state(
  requested_state_key text,
  expected_revision bigint,
  requested_snapshot jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public_projection
AS $$
DECLARE
  next_revision bigint;
BEGIN
  IF requested_state_key IS NULL OR length(requested_state_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'state key must contain between 1 and 200 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF expected_revision IS NULL OR expected_revision < 0 THEN
    RAISE EXCEPTION 'expected revision must be non-negative'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF requested_snapshot IS NULL
    OR jsonb_typeof(requested_snapshot) <> 'object'
    OR requested_snapshot ->> 'stateKind'
      <> 'DISPLAY_INVITATION_STATE_SNAPSHOT' THEN
    RAISE EXCEPTION 'invalid display invitation snapshot'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF expected_revision = 0 THEN
    INSERT INTO public_projection.display_invitation_state AS state (
      state_key,
      revision,
      snapshot
    ) VALUES (
      requested_state_key,
      1,
      requested_snapshot
    )
    ON CONFLICT (state_key) DO NOTHING
    RETURNING state.revision INTO next_revision;
  ELSE
    UPDATE public_projection.display_invitation_state AS state
    SET revision = state.revision + 1,
        snapshot = requested_snapshot,
        updated_at = transaction_timestamp()
    WHERE state.state_key = requested_state_key
      AND state.revision = expected_revision
    RETURNING state.revision INTO next_revision;
  END IF;

  IF next_revision IS NULL THEN
    RAISE EXCEPTION 'display invitation state revision conflict'
      USING ERRCODE = 'serialization_failure';
  END IF;
  RETURN next_revision;
END;
$$;

REVOKE ALL PRIVILEGES ON TABLE public_projection.display_invitation_state
  FROM PUBLIC, projection_app;
REVOKE ALL PRIVILEGES ON FUNCTION public_projection.read_invitation_state(text)
  FROM PUBLIC;
REVOKE ALL PRIVILEGES ON FUNCTION public_projection.write_invitation_state(text, bigint, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_projection.read_invitation_state(text) TO projection_app;
GRANT EXECUTE ON FUNCTION public_projection.write_invitation_state(text, bigint, jsonb)
  TO projection_app;
