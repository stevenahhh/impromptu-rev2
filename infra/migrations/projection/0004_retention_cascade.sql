SET ROLE impromptu_owner;

ALTER TABLE public_projection.projection_sessions
  ADD COLUMN tenant_id uuid;

UPDATE public_projection.projection_sessions AS projection
SET tenant_id = ownership.tenant_id
FROM (
  SELECT projection_id, min(tenant_id::text)::uuid AS tenant_id
  FROM public_projection.publication_inbox
  GROUP BY projection_id
  HAVING count(DISTINCT tenant_id) = 1
) AS ownership
WHERE ownership.projection_id = projection.projection_id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public_projection.projection_sessions WHERE tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'cannot establish tenant ownership for existing projection retention';
  END IF;
END;
$$;

ALTER TABLE public_projection.projection_sessions
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX projection_sessions_tenant_retention
  ON public_projection.projection_sessions (tenant_id, updated_at, projection_id);

CREATE FUNCTION public_projection.apply_retention(
  requested_tenant_id uuid,
  retained_before timestamptz
)
RETURNS TABLE (
  deleted_projections bigint,
  deleted_cards bigint,
  deleted_receipts bigint,
  deleted_publication_events bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public_projection
AS $$
DECLARE
  projection_count bigint;
  card_count bigint;
  receipt_count bigint;
  publication_count bigint;
BEGIN
  IF requested_tenant_id IS NULL OR retained_before IS NULL THEN
    RAISE EXCEPTION 'tenant and retention cutoff are required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT count(*) INTO card_count
  FROM public_projection.audience_cards AS card
  JOIN public_projection.projection_sessions AS projection USING (projection_id)
  WHERE projection.tenant_id = requested_tenant_id
    AND projection.updated_at < retained_before;

  SELECT count(*) INTO receipt_count
  FROM public_projection.display_receipts AS receipt
  JOIN public_projection.projection_sessions AS projection USING (projection_id)
  WHERE projection.tenant_id = requested_tenant_id
    AND projection.updated_at < retained_before;

  DELETE FROM public_projection.projection_sessions
  WHERE tenant_id = requested_tenant_id
    AND updated_at < retained_before;
  GET DIAGNOSTICS projection_count = ROW_COUNT;

  WITH deleted AS (
    DELETE FROM public_projection.applied_publications AS applied
    USING public_projection.publication_inbox AS inbox
    WHERE applied.dispatch_key = inbox.dispatch_key
      AND inbox.tenant_id = requested_tenant_id
      AND inbox.received_at < retained_before
    RETURNING applied.dispatch_key
  )
  SELECT count(*) INTO publication_count FROM deleted;

  DELETE FROM public_projection.publication_inbox
  WHERE tenant_id = requested_tenant_id
    AND received_at < retained_before;

  RETURN QUERY SELECT projection_count, card_count, receipt_count, publication_count;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public_projection.apply_retention(uuid, timestamptz) FROM PUBLIC;
GRANT USAGE ON SCHEMA public_projection TO retention_worker;
GRANT EXECUTE ON FUNCTION public_projection.apply_retention(uuid, timestamptz) TO retention_worker;
