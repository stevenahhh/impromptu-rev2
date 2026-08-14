SET ROLE impromptu_owner;

CREATE INDEX publication_outbox_undelivered
  ON private_app.publication_outbox (created_at, tenant_id, outbox_id)
  WHERE delivered_at IS NULL;

CREATE POLICY dispatcher_outbox_access ON private_app.publication_outbox
  AS PERMISSIVE FOR ALL TO publication_dispatcher
  USING (true)
  WITH CHECK (true);

GRANT USAGE ON SCHEMA private_app TO publication_dispatcher;
GRANT SELECT, UPDATE ON TABLE private_app.publication_outbox TO publication_dispatcher;
