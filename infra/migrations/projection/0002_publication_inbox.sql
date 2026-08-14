SET ROLE impromptu_owner;

CREATE TABLE public_projection.publication_inbox (
  dispatch_key uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  projection_id uuid NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'upsert_projection',
    'publish_card',
    'retract_card',
    'end_projection'
  )),
  public_payload jsonb NOT NULL CHECK (jsonb_typeof(public_payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE public_projection.applied_publications (
  dispatch_key uuid PRIMARY KEY
    REFERENCES public_projection.publication_inbox(dispatch_key) ON DELETE RESTRICT,
  projection_id uuid NOT NULL,
  event_kind text NOT NULL,
  public_payload jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

ALTER TABLE public_projection.publication_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_projection.publication_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_internal ON public_projection.publication_inbox
  AS PERMISSIVE FOR ALL TO impromptu_owner
  USING (true)
  WITH CHECK (true);

ALTER TABLE public_projection.applied_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_projection.applied_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_internal ON public_projection.applied_publications
  AS PERMISSIVE FOR ALL TO impromptu_owner
  USING (true)
  WITH CHECK (true);

CREATE FUNCTION public_projection.dispatch_publication(
  requested_dispatch_key uuid,
  requested_tenant_id uuid,
  requested_projection_id uuid,
  requested_event_kind text,
  requested_public_payload jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public_projection
AS $$
DECLARE
  was_inserted boolean := false;
  existing public_projection.publication_inbox%ROWTYPE;
BEGIN
  INSERT INTO public_projection.publication_inbox (
    dispatch_key,
    tenant_id,
    projection_id,
    event_kind,
    public_payload
  )
  VALUES (
    requested_dispatch_key,
    requested_tenant_id,
    requested_projection_id,
    requested_event_kind,
    requested_public_payload
  )
  ON CONFLICT (dispatch_key) DO NOTHING
  RETURNING true INTO was_inserted;

  IF was_inserted THEN
    INSERT INTO public_projection.applied_publications (
      dispatch_key,
      projection_id,
      event_kind,
      public_payload
    )
    VALUES (
      requested_dispatch_key,
      requested_projection_id,
      requested_event_kind,
      requested_public_payload
    );
    RETURN 'APPLIED';
  END IF;

  SELECT * INTO STRICT existing
  FROM public_projection.publication_inbox
  WHERE dispatch_key = requested_dispatch_key;

  IF existing.tenant_id <> requested_tenant_id
    OR existing.projection_id <> requested_projection_id
    OR existing.event_kind <> requested_event_kind
    OR existing.public_payload <> requested_public_payload THEN
    RAISE EXCEPTION 'dispatch key conflicts with the accepted publication'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN 'DUPLICATE';
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public_projection.dispatch_publication(
  uuid,
  uuid,
  uuid,
  text,
  jsonb
) FROM PUBLIC;

GRANT USAGE ON SCHEMA public_projection TO publication_dispatcher;
GRANT EXECUTE ON FUNCTION public_projection.dispatch_publication(
  uuid,
  uuid,
  uuid,
  text,
  jsonb
) TO publication_dispatcher;
